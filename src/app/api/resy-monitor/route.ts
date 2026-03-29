import { NextResponse } from "next/server";
import { restaurants } from "@/data/restaurants";
import {
  checkVenueAvailability,
  getForwardDates,
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

// In-memory monitor state (persists across requests while the server is running)
let monitorState: MonitorState = createMonitorState();

/**
 * POST /api/resy-monitor
 *
 * Poll all monitored restaurants for availability changes.
 *
 * Body: {
 *   restaurantIds?: string[]  — which restaurants to check (default: all with venueId)
 *   partySize?: number        — party size filter (default: 2)
 *   daysAhead?: number        — how many days forward to scan (default: uses restaurant's advanceDays)
 *   reset?: boolean           — reset monitor state (clear baseline)
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
    } = body as {
      restaurantIds?: string[];
      partySize?: number;
      daysAhead?: number;
      reset?: boolean;
    };

    if (reset) {
      monitorState = createMonitorState();
      return NextResponse.json({ message: "Monitor state reset.", pollCount: 0 });
    }

    // Determine which restaurants to monitor
    const monitorable = restaurants.filter(
      (r) =>
        r.resyVenueId !== null &&
        r.resyUrl !== null &&
        (r.reservationMethod === "resy" || r.reservationMethod === "both"),
    );

    const targets = restaurantIds
      ? monitorable.filter((r) => restaurantIds.includes(r.id))
      : monitorable;

    if (targets.length === 0) {
      return NextResponse.json(
        { error: "No monitorable restaurants found. Ensure restaurants have a resyVenueId." },
        { status: 400 },
      );
    }

    const isBaseline = monitorState.pollCount === 0;
    const diffs: SerializableSlotDiff[] = [];

    for (const restaurant of targets) {
      const monitored: MonitoredRestaurant = {
        id: restaurant.id,
        name: restaurant.name,
        resyVenueId: restaurant.resyVenueId!,
        resyUrl: restaurant.resyUrl!,
        advanceDays: restaurant.advanceDays,
      };

      const lookAhead = daysAhead ?? restaurant.advanceDays;
      const dates = getForwardDates(Math.min(lookAhead, 30)); // cap at 30 days

      const slots = await checkVenueAvailability(
        monitored.resyVenueId,
        monitored.name,
        monitored.resyUrl,
        dates,
        partySize,
      );

      const diff = updateSnapshot(monitorState, monitored, slots);
      diffs.push({
        restaurant: diff.restaurant,
        newSlots: diff.newSlots,
        droppedSlots: diff.droppedSlots,
        totalAvailable: diff.totalAvailable,
        checkedAt: diff.checkedAt,
      });
    }

    monitorState.pollCount++;
    monitorState.lastPollAt = new Date().toISOString();

    const result: MonitorPollResult = {
      diffs,
      pollCount: monitorState.pollCount,
      lastPollAt: monitorState.lastPollAt,
      isBaseline,
      summary: formatPollSummary(diffs, isBaseline),
    };

    return NextResponse.json(result);
  } catch (err) {
    console.error("Monitor poll error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/resy-monitor
 *
 * Return current monitor status and recent diffs.
 */
export async function GET() {
  const recentDiffs = monitorState.diffs.slice(0, 20).map((d) => ({
    restaurant: d.restaurant,
    newSlots: d.newSlots,
    droppedSlots: d.droppedSlots,
    totalAvailable: d.totalAvailable,
    checkedAt: d.checkedAt,
  }));

  // Build per-restaurant summary from snapshots
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
  });
}
