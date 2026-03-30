import { restaurants } from "@/data/restaurants";
import {
  checkVenueAvailability,
  getForwardDates,
  resolveVenueId,
  getRateLimitStats,
  isQuietHours,
  getRecommendedInterval,
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
import { getCachedAuth } from "@/lib/resyBooking";

export const maxDuration = 120;

let monitorState: MonitorState = createMonitorState();
const venueIdCache = new Map<string, number>();
let notificationConfig: NotificationConfig = {};
let rotationIndex = 0;
const RESTAURANTS_PER_POLL = 10;

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
    } = body as {
      restaurantIds?: string[];
      partySize?: number;
      daysAhead?: number;
      reset?: boolean;
      resolveIds?: boolean;
      notifications?: NotificationConfig;
      authToken?: string;
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
    const auth = authToken ? { authToken } : getCachedAuth();

    // Rotation: subset per poll (all on baseline)
    let pollTargets: MonitoredRestaurant[];
    if (isBaseline) {
      pollTargets = monitored;
    } else {
      const start = rotationIndex % monitored.length;
      pollTargets = [];
      for (let i = 0; i < Math.min(RESTAURANTS_PER_POLL, monitored.length); i++) {
        pollTargets.push(monitored[(start + i) % monitored.length]);
      }
      rotationIndex = (start + RESTAURANTS_PER_POLL) % monitored.length;
    }

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
      const TIME_BUDGET_MS = 55_000;
      let processedCount = 0;

      // Process in batches of 2 restaurants at a time (gentler on Resy API)
      const BATCH_SIZE = quiet ? 1 : 2;

      for (let batchStart = 0; batchStart < pollTargets.length; batchStart += BATCH_SIZE) {
        if (Date.now() - pollStart > TIME_BUDGET_MS) {
          console.warn(`[Poll #${pollNum}] Time budget hit after ${processedCount}/${pollTargets.length}`);
          break;
        }

        const batch = pollTargets.slice(batchStart, batchStart + BATCH_SIZE);

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
            const lookAhead = daysAhead ?? Math.min(restaurant.advanceDays, 14);
            const effectiveLookAhead = quiet ? Math.min(lookAhead, 7) : lookAhead;
            const dates = getForwardDates(effectiveLookAhead);

            const slots = await checkVenueAvailability(
              restaurant.resyVenueId,
              restaurant.name,
              restaurant.resyUrl,
              dates,
              partySize,
              auth?.authToken,
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

        // Delay between restaurant batches (1-2s)
        if (batchStart + BATCH_SIZE < pollTargets.length) {
          await delay(1000 + Math.random() * 1000);
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
      console.log(`[Poll #${monitorState.pollCount}] Done ${elapsed}s | ${totalSlots} slots | ${totalNew} new${rlSuffix}`);

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
