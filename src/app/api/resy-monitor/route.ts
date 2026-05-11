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
  hasValidCookies,
  markPollSuccess,
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
import { getCachedAuth, setAuthFromToken, getSlotDetails, getSlotDetailsParallel, bookReservation, fetchExistingReservations, hasTimeConflict, invalidateReservationCache } from "@/lib/resyBooking";

export const maxDuration = 120;

let monitorState: MonitorState = createMonitorState();
const venueIdCache = new Map<string, number>();
const venueResolutionFailed = new Set<string>(); // IDs that returned no venue — skip on future polls
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
      timeFilters?: { preferredDays?: string[]; dayTimeWindows?: Record<string, { start?: string; end?: string }>; blackoutDates?: Array<{ date: string }> };
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
        (r) => r.resyVenueId === null && r.resyUrl !== null && !venueIdCache.has(r.id) && !venueResolutionFailed.has(r.id),
      );
      for (const r of needsResolution) {
        const slug = r.resyUrl!.split("/venues/")[1];
        if (!slug) { venueResolutionFailed.add(r.id); continue; }
        const venueId = await resolveVenueId(slug);
        if (venueId) {
          venueIdCache.set(r.id, venueId);
        } else {
          venueResolutionFailed.add(r.id);
          console.warn(`[Monitor] Could not resolve venue ID for ${r.id} (${slug}) — skipping future resolution`);
        }
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
    const autoBookReady = !!(autoBookIds && autoBookIds.length > 0 && auth?.authToken && (paymentMethodId ?? (auth as { paymentMethodId?: number | null })?.paymentMethodId) != null);
    console.log(`[Poll #${pollNum}] ${pollTargets.length}/${monitored.length} restaurants | party=${partySize} | auth=${!!auth?.authToken} | autoBook=${autoBookReady}(ids=${autoBookIds?.length ?? 0},pay=${paymentMethodId ?? (auth as { paymentMethodId?: number | null })?.paymentMethodId ?? "none"})`);

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

      // #8: Larger batch size for speed (3 during peak, 2 quiet, 1 if warm-up failed)
      const cookiesValid = hasValidCookies();
      const BATCH_SIZE = !cookiesValid ? 1 : quiet ? 2 : 3;
      let consecutiveAllFailBatches = 0; // #7: Track consecutive all-fail batches

      for (let batchStart = 0; batchStart < pollTargets.length; batchStart += BATCH_SIZE) {
        if (Date.now() - pollStart > TIME_BUDGET_MS) {
          console.warn(`[Poll #${pollNum}] #7 Time budget hit after ${processedCount}/${pollTargets.length}`);
          break;
        }

        // #7: Early exit if first 3 batches ALL returned 0 slots AND we've checked 6+ restaurants
        // (raised from 2 to avoid false positives when a few venues just have no availability)
        if (consecutiveAllFailBatches >= 3 && processedCount >= 6) {
          console.warn(`[Poll #${pollNum}] #7 Early exit — ${consecutiveAllFailBatches} consecutive batches returned 0 slots (likely WAF blocked)`);
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
            const lookAhead = daysAhead ?? Math.min(restaurant.advanceDays, 14);
            const effectiveLookAhead = quiet ? Math.min(lookAhead, 7) : lookAhead;
            let dates = getForwardDates(effectiveLookAhead);

            // Filter to preferred days if set — avoids wasting API calls on
            // dates the user doesn't care about (e.g., checking Tue/Wed when
            // user only wants Thu/Fri/Sat)
            const prefDays = timeFilters?.preferredDays;
            if (prefDays && prefDays.length > 0) {
              const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
              const prefSet = new Set(prefDays);
              dates = dates.filter(d => {
                const dow = new Date(d + "T12:00:00").getDay();
                return prefSet.has(dayNames[dow]);
              });
            }

            // Limit to maxDates after filtering
            dates = dates.slice(0, maxDates);

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

        // #7: Track consecutive all-fail batches for early exit
        const batchHasSlots = batchResults.some(r => (r.currentSlots?.length ?? 0) > 0);
        if (batchHasSlots) {
          consecutiveAllFailBatches = 0;
        } else {
          consecutiveAllFailBatches++;
        }

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
        if (autoBookIds && autoBookIds.length > 0 && auth?.authToken && effectivePaymentId != null) {
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
                if (tw.start && slot.time < tw.start) return false;
                if (tw.end && slot.time > tw.end) return false;
              }
              return true;
            }) : candidates;

            if (matching.length === 0) continue;

            // Fetch existing reservations for conflict check
            let existing: Awaited<ReturnType<typeof fetchExistingReservations>> = [];
            try {
              existing = await fetchExistingReservations(auth.authToken);
            } catch { /* continue without conflict check */ }

            // Filter out time conflicts before attempting booking
            const nonConflicting = matching.filter(slot => !hasTimeConflict(existing, slot.date, slot.time));
            if (nonConflicting.length === 0) continue;

            // #6: Fetch slot details in PARALLEL (all at once), then book first success
            const slotsForDetails = nonConflicting.slice(0, 5).map(s => ({ configToken: s.configToken, date: s.date, time: s.time }));
            const parallelResult = await getSlotDetailsParallel(auth.authToken, slotsForDetails, partySize);

            if ("errors" in parallelResult) {
              // All failed — log and stream failure for first slot
              console.log(`[AutoBook] ${serialized.restaurant.name}: #6 all ${slotsForDetails.length} details failed`);
              await write({
                type: "booking",
                restaurant: serialized.restaurant.name,
                restaurantId: serialized.restaurant.id,
                date: slotsForDetails[0].date,
                time: slotsForDetails[0].time,
                success: false,
                error: `All ${slotsForDetails.length} slot details failed`,
              });
            } else {
              // Got a bookable slot — try to book it
              const { slot, details } = parallelResult;
              const bookStart = Date.now();
              const result = await bookReservation(auth.authToken, details.bookToken, effectivePaymentId);
              const bookMs = Date.now() - bookStart;

              if (result.success) {
                console.log(`[AutoBook] BOOKED ${serialized.restaurant.name} ${slot.date} ${slot.time} in ${bookMs}ms`);
                // Invalidate reservation cache so next restaurant's conflict check
                // sees this new booking (prevents double-booking same evening)
                invalidateReservationCache();
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
                console.log(`[AutoBook] Failed ${serialized.restaurant.name} ${slot.date} ${slot.time} in ${bookMs}ms: ${result.error}`);
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

        // #4: Gaussian-like jitter between restaurant batches (200-900ms, centered ~500ms)
        if (batchStart + BATCH_SIZE < pollTargets.length) {
          const r = (Math.random() + Math.random() + Math.random()) / 3;
          await delay(200 + r * 700);
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

      // Signal whether this poll had any successful API calls
      const had200s = (rlStats.pollStatusCounts[200] ?? 0) > 0;
      markPollSuccess(had200s);

      // Per-restaurant summary (only when interesting — slots found or all-zero)
      if (diffs.length > 0) {
        const withSlots = diffs.filter(d => d.totalAvailable > 0);
        const withNew = diffs.filter(d => d.newSlots.length > 0);
        if (withSlots.length > 0) {
          const summary = withSlots.map(d => `${d.restaurant.name}=${d.totalAvailable}${d.newSlots.length > 0 ? `(+${d.newSlots.length}new)` : ""}`).join(" | ");
          console.log(`[Poll #${monitorState.pollCount}] Availability: ${summary}`);
        }
        if (withNew.length > 0) {
          console.log(`[Poll #${monitorState.pollCount}] NEW SLOTS: ${withNew.map(d => `${d.restaurant.name} — ${d.newSlots.map(s => `${s.date} ${s.time}`).join(", ")}`).join(" | ")}`);
        }
        // WAF diagnosis
        const total500s = rlStats.pollStatusCounts[500] ?? 0;
        const totalReqs = Object.values(rlStats.pollStatusCounts).reduce((a, b) => a + b, 0);
        if (total500s > 0 && total500s === totalReqs) {
          console.warn(`[Poll #${monitorState.pollCount}] WAF BLOCKED — all ${total500s} requests returned 500. Likely Imperva blocking. Cookies may need refresh. Next poll will warm up.`);
        }
      }

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
