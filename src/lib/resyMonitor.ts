/**
 * Resy Reservation Monitor — detects net-new availability slots.
 *
 * Features:
 * - Slot diffing: compares current vs previous availability per restaurant
 * - Staggered restaurant polling: randomizes order and spreads requests
 * - Duplicate suppression: 10-minute cooldown per slot to avoid alert spam
 * - Polling strategy: smart intervals based on time-of-day and rate limit state
 */

import type { AvailabilitySlot } from "./resyApi";

export interface MonitoredRestaurant {
  id: string;
  name: string;
  resyVenueId: number;
  resyUrl: string;
  advanceDays: number;
}

export interface SlotDiff {
  restaurant: MonitoredRestaurant;
  newSlots: AvailabilitySlot[];
  droppedSlots: AvailabilitySlot[];
  totalAvailable: number;
  checkedAt: string; // ISO timestamp
}

export interface MonitorSnapshot {
  restaurantId: string;
  slotIds: Set<string>;
  slots: Map<string, AvailabilitySlot>;
  checkedAt: string;
}

// ─── Duplicate Suppression ───────────────────────────────────────────────────

/** Track recently-alerted slot IDs to avoid re-alerting within cooldown. */
const recentAlerts = new Map<string, number>(); // slotId → timestamp
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

function isRecentlyAlerted(slotId: string): boolean {
  const alertedAt = recentAlerts.get(slotId);
  if (!alertedAt) return false;
  if (Date.now() - alertedAt > ALERT_COOLDOWN_MS) {
    recentAlerts.delete(slotId);
    return false;
  }
  return true;
}

function markAlerted(slotId: string): void {
  recentAlerts.set(slotId, Date.now());
  // Prune old entries periodically
  if (recentAlerts.size > 5000) {
    const cutoff = Date.now() - ALERT_COOLDOWN_MS;
    for (const [id, ts] of recentAlerts) {
      if (ts < cutoff) recentAlerts.delete(id);
    }
  }
}

// ─── Monitor State ───────────────────────────────────────────────────────────

export interface MonitorState {
  snapshots: Map<string, MonitorSnapshot>;
  diffs: SlotDiff[];
  isRunning: boolean;
  lastPollAt: string | null;
  pollCount: number;
}

export function createMonitorState(): MonitorState {
  return {
    snapshots: new Map(),
    diffs: [],
    isRunning: false,
    lastPollAt: null,
    pollCount: 0,
  };
}

// ─── Slot Diffing ────────────────────────────────────────────────────────────

/**
 * Compare current slots against the previous snapshot for a restaurant.
 * Filters out recently-alerted slots to suppress duplicates.
 *
 * On the very first poll for a restaurant, all slots are recorded as baseline
 * (newSlots is populated for tracking but won't trigger alerts).
 */
export function diffSlots(
  restaurant: MonitoredRestaurant,
  currentSlots: AvailabilitySlot[],
  previousSnapshot: MonitorSnapshot | undefined,
): SlotDiff {
  const now = new Date().toISOString();
  const currentIds = new Set(currentSlots.map((s) => s.id));

  if (!previousSnapshot) {
    // First poll — baseline. Mark all as "seen" so they don't alert later.
    for (const slot of currentSlots) {
      markAlerted(slot.id);
    }
    return {
      restaurant,
      newSlots: currentSlots,
      droppedSlots: [],
      totalAvailable: currentSlots.length,
      checkedAt: now,
    };
  }

  const previousIds = previousSnapshot.slotIds;

  // New = in current but not in previous, and not recently alerted
  const newSlots = currentSlots.filter(
    (s) => !previousIds.has(s.id) && !isRecentlyAlerted(s.id),
  );

  // Mark new slots as alerted
  for (const slot of newSlots) {
    markAlerted(slot.id);
  }

  // Dropped = in previous but not in current
  const droppedSlots: AvailabilitySlot[] = [];
  for (const prevId of previousIds) {
    if (!currentIds.has(prevId)) {
      const slot = previousSnapshot.slots.get(prevId);
      if (slot) droppedSlots.push(slot);
    }
  }

  return {
    restaurant,
    newSlots,
    droppedSlots,
    totalAvailable: currentSlots.length,
    checkedAt: now,
  };
}

/**
 * Update the monitor state with fresh availability data for a restaurant.
 */
export function updateSnapshot(
  state: MonitorState,
  restaurant: MonitoredRestaurant,
  currentSlots: AvailabilitySlot[],
): SlotDiff {
  const previousSnapshot = state.snapshots.get(restaurant.id);
  const diff = diffSlots(restaurant, currentSlots, previousSnapshot);

  const now = new Date().toISOString();
  state.snapshots.set(restaurant.id, {
    restaurantId: restaurant.id,
    slotIds: new Set(currentSlots.map((s) => s.id)),
    slots: new Map(currentSlots.map((s) => [s.id, s])),
    checkedAt: now,
  });

  // Only record diffs with actual changes (skip baseline)
  if (
    previousSnapshot &&
    (diff.newSlots.length > 0 || diff.droppedSlots.length > 0)
  ) {
    state.diffs.unshift(diff);
    if (state.diffs.length > 200) {
      state.diffs = state.diffs.slice(0, 200);
    }
  }

  return diff;
}

// ─── Restaurant Polling Strategy ─────────────────────────────────────────────

/**
 * Shuffle an array using Fisher-Yates. Returns a new array.
 * Used to randomize restaurant polling order each cycle.
 */
export function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Split restaurants into batches for staggered polling.
 * This spreads requests over time instead of hitting all venues at once.
 */
export function batchRestaurants(
  restaurants: MonitoredRestaurant[],
  batchSize: number = 3,
): MonitoredRestaurant[][] {
  const shuffled = shuffleArray(restaurants);
  const batches: MonitoredRestaurant[][] = [];
  for (let i = 0; i < shuffled.length; i += batchSize) {
    batches.push(shuffled.slice(i, i + batchSize));
  }
  return batches;
}

// ─── Serializable types for API transport ────────────────────────────────────

export interface SerializableSlotDiff {
  restaurant: MonitoredRestaurant;
  currentSlots: AvailabilitySlot[]; // ALL currently available slots
  newSlots: AvailabilitySlot[];
  droppedSlots: AvailabilitySlot[];
  totalAvailable: number;
  checkedAt: string;
}

export interface MonitorPollResult {
  diffs: SerializableSlotDiff[];
  pollCount: number;
  lastPollAt: string;
  isBaseline: boolean;
  summary: string;
  rateLimitStats?: {
    totalRequests: number;
    total429s: number;
    isBackedOff: boolean;
    backoffRemaining: number;
  };
  notificationsSent?: string[];
  notificationsFailed?: string[];
}

/**
 * Format a human-readable summary of a poll result.
 */
export function formatPollSummary(
  diffs: SlotDiff[],
  isBaseline: boolean,
): string {
  if (isBaseline) {
    const totalSlots = diffs.reduce((sum, d) => sum + d.totalAvailable, 0);
    const restaurants = diffs.filter((d) => d.totalAvailable > 0).length;
    return `Baseline scan: ${totalSlots} slots across ${restaurants} restaurants.`;
  }

  const newTotal = diffs.reduce((sum, d) => sum + d.newSlots.length, 0);
  const droppedTotal = diffs.reduce(
    (sum, d) => sum + d.droppedSlots.length,
    0,
  );

  if (newTotal === 0 && droppedTotal === 0) {
    return "No changes detected.";
  }

  const parts: string[] = [];
  if (newTotal > 0)
    parts.push(`${newTotal} new slot${newTotal !== 1 ? "s" : ""} found`);
  if (droppedTotal > 0)
    parts.push(
      `${droppedTotal} slot${droppedTotal !== 1 ? "s" : ""} taken`,
    );
  return parts.join(", ") + ".";
}
