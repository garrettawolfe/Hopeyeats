import { NextResponse } from "next/server";
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

// In-memory monitor state (persists across requests while the server runs)
let monitorState: MonitorState = createMonitorState();

// Cache resolved venue IDs so we don't re-resolve every poll
const venueIdCache = new Map<string, number>();

// Persisted notification config (set via POST, used on every poll)
let notificationConfig: NotificationConfig = {};

/** Small random delay between batches (2-5s). */
function batchDelay(): Promise<void> {
  const ms = 2000 + Math.random() * 3000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /api/resy-monitor
 *
 * Poll selected restaurants for availability changes.
 *
 * Body: {
 *   restaurantIds?: string[]  — which restaurants to check (default: all with venueId)
 *   partySize?: number        — party size filter (default: 2)
 *   daysAhead?: number        — how many days forward to scan (overrides per-restaurant advanceDays)
 *   reset?: boolean           — reset monitor state (clear baseline)
 *   resolveIds?: boolean      — attempt to resolve missing venue IDs via Resy API
 *   notifications?: NotificationConfig — configure notification channels
 * }
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
      return NextResponse.json({ message: "Monitor state reset.", pollCount: 0 });
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

        // Delay between resolution requests
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
        // Use cached venue ID if the static one is null
        effectiveVenueId: r.resyVenueId ?? venueIdCache.get(r.id) ?? null,
      }))
      .filter((r) => r.effectiveVenueId !== null);

    const targets = restaurantIds
      ? monitorable.filter((r) => restaurantIds.includes(r.id))
      : monitorable;

    if (targets.length === 0) {
      return NextResponse.json(
        {
          error:
            "No monitorable restaurants found. Try enabling 'Resolve IDs' to discover venue IDs.",
          monitorableCount: 0,
        },
        { status: 400 },
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

    // ── Staggered polling: batch restaurants ─────────────────────────────
    const batches = batchRestaurants(monitored, quiet ? 2 : 3);
    const isBaseline = monitorState.pollCount === 0;
    const diffs: SerializableSlotDiff[] = [];

    for (const batch of batches) {
      // Process each restaurant in the batch
      for (const restaurant of batch) {
        const lookAhead = daysAhead ?? Math.min(restaurant.advanceDays, 30);
        // During quiet hours, only check the next 7 days (cancellation window)
        const effectiveLookAhead = quiet
          ? Math.min(lookAhead, 7)
          : lookAhead;
        const dates = getForwardDates(effectiveLookAhead);

        const slots = await checkVenueAvailability(
          restaurant.resyVenueId,
          restaurant.name,
          restaurant.resyUrl,
          dates,
          partySize,
        );

        const diff = updateSnapshot(monitorState, restaurant, slots);
        diffs.push({
          restaurant: diff.restaurant,
          newSlots: diff.newSlots,
          droppedSlots: diff.droppedSlots,
          totalAvailable: diff.totalAvailable,
          checkedAt: diff.checkedAt,
        });
      }

      // Random delay between batches
      if (batches.indexOf(batch) < batches.length - 1) {
        await batchDelay();
      }
    }

    monitorState.pollCount++;
    monitorState.lastPollAt = new Date().toISOString();

    // ── Send notifications for new slots (skip baseline) ────────────────
    let notifyResult: { sent: string[]; failed: string[] } | undefined;
    if (!isBaseline) {
      const alerts = diffs
        .filter((d) => d.newSlots.length > 0)
        .map((d) => ({ restaurant: d.restaurant, newSlots: d.newSlots }));

      if (alerts.length > 0) {
        // Derive base URL from the request
        const url = new URL(request.url);
        const baseUrl = `${url.protocol}//${url.host}`;
        notifyResult = await sendNotifications(
          notificationConfig,
          alerts,
          baseUrl,
        );
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

    return NextResponse.json(result);
  } catch (err) {
    console.error("[Monitor] Poll error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/resy-monitor
 *
 * Return current monitor status, recent diffs, and rate limit info.
 */
export async function GET() {
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
