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
  batchRestaurants,
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

// Allow up to 120s for Vercel Pro (default is 10s on free tier)
export const maxDuration = 120;

// In-memory monitor state (persists across requests while the server runs)
let monitorState: MonitorState = createMonitorState();

// Cache resolved venue IDs so we don't re-resolve every poll
const venueIdCache = new Map<string, number>();

// Persisted notification config (set via POST, used on every poll)
let notificationConfig: NotificationConfig = {};

// Rotation index — check a subset of restaurants per poll, rotating through all
let rotationIndex = 0;
const RESTAURANTS_PER_POLL = 8;

/** Small random delay between batches (1-2s). */
function batchDelay(): Promise<void> {
  const ms = 1000 + Math.random() * 1000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /api/resy-monitor
 *
 * Poll selected restaurants for availability changes.
 * Returns a newline-delimited JSON stream so the client can update incrementally.
 *
 * Stream events:
 *   { type: "progress", restaurant: string, index: number, total: number }
 *   { type: "result", diff: SerializableSlotDiff }
 *   { type: "cached", diff: SerializableSlotDiff }
 *   { type: "done", pollResult: MonitorPollResult }
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
    } = body as {
      restaurantIds?: string[];
      partySize?: number;
      daysAhead?: number;
      reset?: boolean;
      resolveIds?: boolean;
      notifications?: NotificationConfig;
    };

    // Update notification config if provided
    if (notifications) {
      notificationConfig = notifications;
    }

    if (reset) {
      monitorState = createMonitorState();
      venueIdCache.clear();
      return new Response(
        JSON.stringify({ type: "done", pollResult: { message: "Monitor state reset.", pollCount: 0 } }) + "\n",
        { headers: { "Content-Type": "application/x-ndjson" } },
      );
    }

    // ── Resolve missing venue IDs if requested ──────────────────────────
    if (resolveIds) {
      const needsResolution = restaurants.filter(
        (r) =>
          r.resyVenueId === null &&
          r.resyUrl !== null &&
          !venueIdCache.has(r.id),
      );

      for (const r of needsResolution) {
        const slug = r.resyUrl!.split("/venues/")[1];
        if (!slug) continue;

        const venueId = await resolveVenueId(slug);
        if (venueId) {
          venueIdCache.set(r.id, venueId);
          console.log(`[Monitor] Resolved ${r.name} → venue ID ${venueId}`);
        }

        await new Promise((resolve) =>
          setTimeout(resolve, 1000 + Math.random() * 2000),
        );
      }
    }

    // ── Determine monitorable restaurants ────────────────────────────────
    const monitorable = restaurants
      .filter(
        (r) =>
          r.resyUrl !== null &&
          (r.reservationMethod === "resy" || r.reservationMethod === "both"),
      )
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
        JSON.stringify({
          type: "done",
          pollResult: {
            error: "No monitorable restaurants found.",
            monitorableCount: 0,
          },
        }) + "\n",
        { status: 400, headers: { "Content-Type": "application/x-ndjson" } },
      );
    }

    // ── Check quiet hours ────────────────────────────────────────────────
    const quiet = isQuietHours();

    // ── Build monitored restaurant list ──────────────────────────────────
    const monitored: MonitoredRestaurant[] = targets.map((r) => ({
      id: r.id,
      name: r.name,
      resyVenueId: r.effectiveVenueId!,
      resyUrl: r.resyUrl!,
      advanceDays: r.advanceDays,
    }));

    // ── Rotate restaurants: check a subset per poll ───────────────────────
    const isBaseline = monitorState.pollCount === 0;

    const auth = getCachedAuth();
    console.log(`[Monitor] Poll #${monitorState.pollCount + 1} | ${monitored.length} restaurants | auth=${!!auth?.authToken} | quiet=${quiet} | baseline=${isBaseline}`);

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

    console.log(`[Monitor] Checking ${pollTargets.length} restaurants: ${pollTargets.map(r => r.name).join(", ")}`);

    // ── Stream response ─────────────────────────────────────────────────
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    const write = async (data: unknown) => {
      await writer.write(encoder.encode(JSON.stringify(data) + "\n"));
    };

    // Process in background, streaming results
    const processAsync = async () => {
      const batches = batchRestaurants(pollTargets, quiet ? 2 : 3);
      const diffs: SerializableSlotDiff[] = [];
      const pollStart = Date.now();
      const TIME_BUDGET_MS = 60_000;
      let timedOut = false;
      let processedCount = 0;

      for (const batch of batches) {
        if (timedOut) break;

        for (const restaurant of batch) {
          if (Date.now() - pollStart > TIME_BUDGET_MS) {
            console.warn(`[Monitor] Time budget exceeded after ${diffs.length}/${pollTargets.length} restaurants`);
            timedOut = true;
            break;
          }

          // Send progress event
          await write({
            type: "progress",
            restaurant: restaurant.name,
            index: processedCount,
            total: pollTargets.length,
          });

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
          const serialized: SerializableSlotDiff = {
            restaurant: diff.restaurant,
            currentSlots: slots,
            newSlots: diff.newSlots,
            droppedSlots: diff.droppedSlots,
            totalAvailable: diff.totalAvailable,
            checkedAt: diff.checkedAt,
          };
          diffs.push(serialized);
          processedCount++;

          // Stream this restaurant's result immediately
          await write({ type: "result", diff: serialized });
        }

        if (batches.indexOf(batch) < batches.length - 1 && !timedOut) {
          await batchDelay();
        }
      }

      // Include cached slots for restaurants NOT checked this poll
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
      console.log(
        `[Monitor] Poll #${monitorState.pollCount} complete in ${elapsed}s | ${diffs.length} restaurants | ${totalSlots} total slots | ${totalNew} new${timedOut ? " | TIMED OUT" : ""}`,
      );

      // ── Send notifications for new slots (skip baseline) ────────────
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

    // Kick off processing (don't await — the stream handles it)
    processAsync().catch(async (err) => {
      console.error("[Monitor] Stream error:", err);
      try {
        await write({ type: "error", error: err instanceof Error ? err.message : "Unknown error" });
        await writer.close();
      } catch {
        // Writer may already be closed
      }
    });

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    console.error("[Monitor] Poll error:", err);
    return new Response(
      JSON.stringify({ type: "error", error: err instanceof Error ? err.message : "Unknown error" }) + "\n",
      { status: 500, headers: { "Content-Type": "application/x-ndjson" } },
    );
  }
}

/**
 * GET /api/resy-monitor
 *
 * Return current monitor status, recent diffs, and rate limit info.
 */
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
