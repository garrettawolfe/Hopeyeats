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

    // ── Rotate restaurants: check a subset per poll ───────────────────────
    // This keeps each poll fast (~10-20s) while covering all restaurants
    // over multiple cycles. On baseline (first poll), check all.
    const isBaseline = monitorState.pollCount === 0;

    let pollTargets: MonitoredRestaurant[];
    if (isBaseline) {
      // First poll: check all restaurants to build initial snapshot
      pollTargets = monitored;
    } else {
      // Subsequent polls: rotate through a subset
      const start = rotationIndex % monitored.length;
      pollTargets = [];
      for (let i = 0; i < Math.min(RESTAURANTS_PER_POLL, monitored.length); i++) {
        pollTargets.push(monitored[(start + i) % monitored.length]);
      }
      rotationIndex = (start + RESTAURANTS_PER_POLL) % monitored.length;
    }

    const batches = batchRestaurants(pollTargets, quiet ? 2 : 3);
    const diffs: SerializableSlotDiff[] = [];

    // Time budget: stop processing after 60s to avoid timeouts
    const pollStart = Date.now();
    const TIME_BUDGET_MS = 60_000;
    let timedOut = false;

    for (const batch of batches) {
      if (timedOut) break;

      for (const restaurant of batch) {
        if (Date.now() - pollStart > TIME_BUDGET_MS) {
          console.warn(`[Monitor] Time budget exceeded after ${diffs.length}/${pollTargets.length} restaurants`);
          timedOut = true;
          break;
        }

        const lookAhead = daysAhead ?? Math.min(restaurant.advanceDays, 14);
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
          currentSlots: slots,
          newSlots: diff.newSlots,
          droppedSlots: diff.droppedSlots,
          totalAvailable: diff.totalAvailable,
          checkedAt: diff.checkedAt,
        });
      }

      if (batches.indexOf(batch) < batches.length - 1 && !timedOut) {
        await batchDelay();
      }
    }

    // Include cached slots for restaurants NOT checked this poll
    {
      const checkedIds = new Set(diffs.map((d) => d.restaurant.id));
      for (const restaurant of monitored) {
        if (checkedIds.has(restaurant.id)) continue;
        const snapshot = monitorState.snapshots.get(restaurant.id);
        if (snapshot) {
          const cachedSlots = Array.from(snapshot.slots.values());
          diffs.push({
            restaurant,
            currentSlots: cachedSlots,
            newSlots: [],
            droppedSlots: [],
            totalAvailable: cachedSlots.length,
            checkedAt: snapshot.checkedAt,
          });
        }
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
