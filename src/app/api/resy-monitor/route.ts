import { restaurants } from "@/data/restaurants";
import {
  checkVenueAvailability,
  getForwardDates,
  resolveVenueId,
  getRateLimitStats,
  resetConsecutiveErrors,
  resetPollDiagnostics,
  getPollDiagnostics,
  isQuietHours,
  getRecommendedInterval,
  warmUpImperva,
} from "@/lib/resyApi";
import {
  createMonitorState,
  updateSnapshot,
  formatPollSummary,
  type MonitorState,
  type MonitoredRestaurant,
  type MonitorPollResult,
  type SerializableSlotDiff,
} from "@/lib/resyMonitor";
import {
  sendNotifications,
  type NotificationConfig,
} from "@/lib/notifications";
import { getCachedAuth, setAuthFromToken, getSlotDetails, bookReservation, fetchExistingReservations, hasTimeConflict } from "@/lib/resyBooking";

export const maxDuration = 120;

let monitorState: MonitorState = createMonitorState();
const venueIdCache = new Map<string, number>();
let notificationConfig: NotificationConfig = {};
// All restaurants polled every cycle (fast enough with 200-400ms gaps)

/** Delay helper */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /api/resy-monitor
 *
 * Streams NDJSON: progress, result, activity, done events.
 * Restaurants within each batch are checked in PARALLEL for speed.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      restaurantIds,
      partySize = 2,
      daysAhead,
      reset = false,
      resolveIds = false,
      notifications,
      authToken,
      autoBookIds,
      paymentMethodId,
      timeFilters,
      dateLimits,
    } = body as {
      restaurantIds?: string[];
      partySize?: number;
      daysAhead?: number;
      reset?: boolean;
      resolveIds?: boolean;
      notifications?: NotificationConfig;
      authToken?: string;
      autoBookIds?: string[];
      paymentMethodId?: number;
      timeFilters?: { preferredDays?: string[]; dayTimeWindows?: Record<string, { earliest?: string; latest?: string }>; blackoutDates?: Array<{ date: string }> };
      dateLimits?: Record<string, number>;
    };

    if (notifications) notificationConfig = notifications;

    if (reset) {
      monitorState = createMonitorState();
      venueIdCache.clear();
      return new Response(
        JSON.stringify({ type: "done", pollResult: { message: "Monitor state reset.", pollCount: 0 } }) + "\n",
        { headers: { "Content-Type": "application/x-ndjson" } },
      );
    }

    // Resolve missing venue IDs
    if (resolveIds) {
      const needsResolution = restaurants.filter(
        (r) => r.resyVenueId === null && r.resyUrl !== null && !venueIdCache.has(r.id),
      );
      for (const r of needsResolution) {
        const slug = r.resyUrl!.split("/venues/")[1];
        if (!slug) continue;
        const venueId = await resolveVenueId(slug);
        if (venueId) venueIdCache.set(r.id, venueId);
        await delay(500 + Math.random() * 1000);
      }
    }

    // Determine monitorable restaurants
    const monitorable = restaurants
      .filter((r) => r.resyUrl !== null && (r.reservationMethod === "resy" || r.reservationMethod === "both"))
      .map((r) => ({
        ...r,
        effectiveVenueId: r.resyVenueId ?? venueIdCache.get(r.id) ?? null,
      }))
      .filter((r) => r.effectiveVenueId !== null);

    const targets = restaurantIds
      ? monitorable.filter((r) => restaurantIds.includes(r.id))
      : monitorable;

    if (targets.length === 0) {
      return new Response(
        JSON.stringify({ type: "done", pollResult: { error: "No monitorable restaurants found.", monitorableCount: 0 } }) + "\n",
        { status: 400, headers: { "Content-Type": "application/x-ndjson" } },
      );
    }

    const quiet = isQuietHours();
    const monitored: MonitoredRestaurant[] = targets.map((r) => ({
      id: r.id,
      name: r.name,
      resyVenueId: r.effectiveVenueId!,
      resyUrl: r.resyUrl!,
      advanceDays: r.advanceDays,
    }));

    const isBaseline = monitorState.pollCount === 0;

    // Use token from request body (client sends it) or fall back to server cache
    let auth: { authToken: string; paymentMethodId?: number | null } | null = null;
    if (authToken) {
      // Resolve payment method for inline booking
      const cached = getCachedAuth();
      if (cached?.authToken === authToken) {
        auth = cached;
      } else if (autoBookIds && autoBookIds.length > 0) {
        // Need payment method for auto-book — validate token
        const validated = await setAuthFromToken(authToken);
        if (!("error" in validated)) {
          auth = validated;
        } else {
          auth = { authToken };
        }
      } else {
        auth = { authToken };
      }
    } else {
      auth = getCachedAuth();
    }

    // Poll all restaurants every cycle (fast enough with 200-400ms gaps)
    const pollTargets = monitored;

    const pollNum = monitorState.pollCount + 1;
    console.log(`[Poll #${pollNum}] ${pollTargets.length}/${monitored.length} restaurants | party=${partySize} | auth=${!!auth?.authToken}`);

    // Stream response
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    const write = async (data: unknown) => {
      await writer.write(encoder.encode(JSON.stringify(data) + "\n"));
    };

    const processAsync = async () => {
      const diffs: SerializableSlotDiff[] = [];
      const pollStart = Date.now();
      const TIME_BUDGET_MS = 100_000;
      let processedCount = 0;

      // Reset error state and diagnostics at start of each poll
      resetConsecutiveErrors();
      resetPollDiagnostics();

      // Warm up Imperva cookies before API calls (GET resy.com → fresh WAF cookies)
      await warmUpImperva();

      // Process in batches of 2 restaurants at a time (gentler on Resy API)
      const BATCH_SIZE = quiet ? 1 : 2;

      for (let batchStart = 0; batchStart < pollTargets.length; batchStart += BATCH_SIZE) {
        if (Date.now() - pollStart > TIME_BUDGET_MS) {
          console.warn(`[Poll #${pollNum}] Time budget hit after ${processedCount}/${pollTargets.length}`);
          break;
        }

        const batch = pollTargets.slice(batchStart, batchStart + BATCH_SIZE);

        // Reset error counter between batches so one venue's 500s don't kill the rest
        resetConsecutiveErrors();

        // Send progress for batch
        await write({
          type: "progress",
          restaurant: batch.map((r) => r.name).join(", "),
          index: processedCount,
          total: pollTargets.length,
        });

        // Check all restaurants in this batch IN PARALLEL
        const batchResults = await Promise.all(
          batch.map(async (restaurant) => {
            const maxDates = dateLimits?.[restaurant.id] ?? 3;
            const lookAhead = daysAhead ?? Math.min(restaurant.advanceDays, maxDates <= 2 ? 7 : 14);
            const effectiveLookAhead = quiet ? Math.min(lookAhead, 7) : lookAhead;
            const dates = getForwardDates(effectiveLookAhead);

            const slots = await checkVenueAvailability(
              restaurant.resyVenueId,
              restaurant.name,
              restaurant.resyUrl,
              dates,
              partySize,
              auth?.authToken,
              maxDates,
            );

            const diff = updateSnapshot(monitorState, restaurant, slots);
            return {
              restaurant: diff.restaurant,
              currentSlots: slots,
              newSlots: diff.newSlots,
              droppedSlots: diff.droppedSlots,
              totalAvailable: diff.totalAvailable,
              checkedAt: diff.checkedAt,
            } as SerializableSlotDiff;
          }),
        );

        // Stream each result + activity feed
        for (const serialized of batchResults) {
          diffs.push(serialized);
          processedCount++;

          await write({ type: "result", diff: serialized });

          // Activity feed event for top bar
          if (serialized.totalAvailable > 0) {
            await write({
              type: "activity",
              restaurant: serialized.restaurant.name,
              slotCount: serialized.totalAvailable,
              newCount: serialized.newSlots.length,
            });
          }
        }

        // Inline auto-book: attempt booking from same serverless instance (shared cookies)
        const effectivePaymentId = paymentMethodId ?? (auth as { paymentMethodId?: number | null })?.paymentMethodId;
        if (autoBookIds && autoBookIds.length > 0 && auth?.authToken && effectivePaymentId) {
          for (const serialized of batchResults) {
            if (!autoBookIds.includes(serialized.restaurant.id)) continue;
            if (serialized.newSlots.length === 0 && !isBaseline) continue;

            const candidates = isBaseline ? (serialized.currentSlots ?? []) : serialized.newSlots;
            if (candidates.length === 0) continue;

            // Filter by time preferences
            const matching = timeFilters ? candidates.filter(slot => {
              const { preferredDays, dayTimeWindows, blackoutDates } = timeFilters;
              if (blackoutDates?.length && blackoutDates.some(bd => bd.date === slot.date)) return false;
              if (!preferredDays?.length) return true;
              const d = new Date(slot.date + "T12:00:00");
              const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
              const dayName = dayNames[d.getDay()];
              if (!preferredDays.includes(dayName)) return false;
              const tw = dayTimeWindows?.[dayName];
              if (tw) {
                if (tw.earliest && slot.time < tw.earliest) return false;
                if (tw.latest && slot.time > tw.latest) return false;
              }
              return true;
            }) : candidates;

            if (matching.length === 0) continue;

            // Fetch existing reservations for conflict check
            let existing: Awaited<ReturnType<typeof fetchExistingReservations>> = [];
            try {
              existing = await fetchExistingReservations(auth.authToken);
            } catch { /* continue without conflict check */ }

            let booked = false;
            for (const slot of matching) {
              if (booked) break;
              if (hasTimeConflict(existing, slot.date, slot.time)) continue;

              const details = await getSlotDetails(auth.authToken, slot.configToken, slot.date, partySize);
              if ("error" in details) {
                console.log(`[AutoBook] ${serialized.restaurant.name} ${slot.date} ${slot.time}: ${details.error}`);
                continue;
              }

              const result = await bookReservation(auth.authToken, details.bookToken, effectivePaymentId);
              if (result.success) {
                booked = true;
                console.log(`[AutoBook] BOOKED ${serialized.restaurant.name} ${slot.date} ${slot.time}`);
                await write({
                  type: "booking",
                  restaurant: serialized.restaurant.name,
                  restaurantId: serialized.restaurant.id,
                  date: slot.date,
                  time: slot.time,
                  success: true,
                  reservationId: result.reservationId,
                });
              } else {
                console.log(`[AutoBook] Failed ${serialized.restaurant.name} ${slot.date} ${slot.time}: ${result.error}`);
                await write({
                  type: "booking",
                  restaurant: serialized.restaurant.name,
                  restaurantId: serialized.restaurant.id,
                  date: slot.date,
                  time: slot.time,
                  success: false,
                  error: result.error,
                });
              }
            }
          }
        }

        // Delay between restaurant batches (300-600ms)
        if (batchStart + BATCH_SIZE < pollTargets.length) {
          await delay(300 + Math.random() * 300);
        }
      }

      // Include cached slots for unchecked restaurants
      const checkedIds = new Set(diffs.map((d) => d.restaurant.id));
      for (const restaurant of monitored) {
        if (checkedIds.has(restaurant.id)) continue;
        const snapshot = monitorState.snapshots.get(restaurant.id);
        if (snapshot) {
          const cachedSlots = Array.from(snapshot.slots.values());
          const cachedDiff: SerializableSlotDiff = {
            restaurant,
            currentSlots: cachedSlots,
            newSlots: [],
            droppedSlots: [],
            totalAvailable: cachedSlots.length,
            checkedAt: snapshot.checkedAt,
          };
          diffs.push(cachedDiff);
          await write({ type: "cached", diff: cachedDiff });
        }
      }

      monitorState.pollCount++;
      monitorState.lastPollAt = new Date().toISOString();

      const totalSlots = diffs.reduce((sum, d) => sum + d.totalAvailable, 0);
      const totalNew = diffs.reduce((sum, d) => sum + d.newSlots.length, 0);
      const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
      const rlStats = getRateLimitStats();
      const rlSuffix = rlStats.consecutiveErrors > 0 ? ` | errors=${rlStats.consecutiveErrors}` : "";
      const diag = getPollDiagnostics();
      console.log(`[Poll #${monitorState.pollCount}] Done ${elapsed}s | ${totalSlots} slots | ${totalNew} new${rlSuffix} | ${diag}`);

      // Notifications
      let notifyResult: { sent: string[]; failed: string[] } | undefined;
      if (!isBaseline) {
        const alerts = diffs
          .filter((d) => d.newSlots.length > 0)
          .map((d) => ({ restaurant: d.restaurant, newSlots: d.newSlots }));
        if (alerts.length > 0) {
          const url = new URL(request.url);
          const baseUrl = `${url.protocol}//${url.host}`;
          notifyResult = await sendNotifications(notificationConfig, alerts, baseUrl);
        }
      }

      const result: MonitorPollResult = {
        diffs,
        pollCount: monitorState.pollCount,
        lastPollAt: monitorState.lastPollAt,
        isBaseline,
        summary: formatPollSummary(diffs, isBaseline),
        rateLimitStats: getRateLimitStats(),
        diagnostics: diag,
        notificationsSent: notifyResult?.sent,
        notificationsFailed: notifyResult?.failed,
      };

      await write({ type: "done", pollResult: result });
      await writer.close();
    };

    processAsync().catch(async (err) => {
      console.error("[Poll] Stream error:", err);
      try {
        await write({ type: "error", error: err instanceof Error ? err.message : "Unknown error" });
        await writer.close();
      } catch { /* writer closed */ }
    });

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    console.error("[Poll] Error:", err);
    return new Response(
      JSON.stringify({ type: "error", error: err instanceof Error ? err.message : "Unknown error" }) + "\n",
      { status: 500, headers: { "Content-Type": "application/x-ndjson" } },
    );
  }
}

export async function GET() {
  const { NextResponse } = await import("next/server");

  const recentDiffs = monitorState.diffs.slice(0, 30).map((d) => ({
    restaurant: d.restaurant,
    newSlots: d.newSlots,
    droppedSlots: d.droppedSlots,
    totalAvailable: d.totalAvailable,
    checkedAt: d.checkedAt,
  }));

  const restaurantStatus = Array.from(monitorState.snapshots.entries()).map(
    ([id, snap]) => ({
      restaurantId: id,
      totalSlots: snap.slotIds.size,
      lastChecked: snap.checkedAt,
    }),
  );

  return NextResponse.json({
    isRunning: monitorState.isRunning,
    pollCount: monitorState.pollCount,
    lastPollAt: monitorState.lastPollAt,
    restaurantStatus,
    recentDiffs,
    rateLimitStats: getRateLimitStats(),
    recommendedInterval: getRecommendedInterval(),
    isQuietHours: isQuietHours(),
  });
}
