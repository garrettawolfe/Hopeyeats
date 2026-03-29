/**
 * Resy Reservation Monitor — detects net-new availability slots.
 *
 * Compares current availability against previously seen slots to surface
 * only genuinely new reservations (cancellations, fresh releases, etc.).
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

export interface MonitorState {
  snapshots: Map<string, MonitorSnapshot>;
  diffs: SlotDiff[];
  isRunning: boolean;
  lastPollAt: string | null;
  pollCount: number;
}

/**
 * Create a fresh monitor state.
 */
export function createMonitorState(): MonitorState {
  return {
    snapshots: new Map(),
    diffs: [],
    isRunning: false,
    lastPollAt: null,
    pollCount: 0,
  };
}

/**
 * Compare current slots against the previous snapshot for a restaurant.
 * Returns the diff (new + dropped slots).
 *
 * On the very first poll for a restaurant, all slots are considered "new"
 * (this is the baseline). Subsequent polls detect only changes.
 */
export function diffSlots(
  restaurant: MonitoredRestaurant,
  currentSlots: AvailabilitySlot[],
  previousSnapshot: MonitorSnapshot | undefined,
): SlotDiff {
  const now = new Date().toISOString();
  const currentIds = new Set(currentSlots.map((s) => s.id));
  const currentMap = new Map(currentSlots.map((s) => [s.id, s]));

  if (!previousSnapshot) {
    // First poll — everything is "new" (baseline)
    return {
      restaurant,
      newSlots: currentSlots,
      droppedSlots: [],
      totalAvailable: currentSlots.length,
      checkedAt: now,
    };
  }

  const previousIds = previousSnapshot.slotIds;

  // New = in current but not in previous
  const newSlots = currentSlots.filter((s) => !previousIds.has(s.id));

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
 * Returns the diff for this restaurant.
 */
export function updateSnapshot(
  state: MonitorState,
  restaurant: MonitoredRestaurant,
  currentSlots: AvailabilitySlot[],
): SlotDiff {
  const previousSnapshot = state.snapshots.get(restaurant.id);
  const diff = diffSlots(restaurant, currentSlots, previousSnapshot);

  // Save new snapshot
  const now = new Date().toISOString();
  state.snapshots.set(restaurant.id, {
    restaurantId: restaurant.id,
    slotIds: new Set(currentSlots.map((s) => s.id)),
    slots: new Map(currentSlots.map((s) => [s.id, s])),
    checkedAt: now,
  });

  // Only record diffs that have actual changes (skip baseline)
  if (previousSnapshot && (diff.newSlots.length > 0 || diff.droppedSlots.length > 0)) {
    state.diffs.unshift(diff); // newest first
    // Keep only last 100 diffs
    if (state.diffs.length > 100) {
      state.diffs = state.diffs.slice(0, 100);
    }
  }

  return diff;
}

// --- Serializable types for API transport ---

export interface SerializableSlotDiff {
  restaurant: MonitoredRestaurant;
  newSlots: AvailabilitySlot[];
  droppedSlots: AvailabilitySlot[];
  totalAvailable: number;
  checkedAt: string;
}

export interface MonitorPollResult {
  diffs: SerializableSlotDiff[];
  pollCount: number;
  lastPollAt: string;
  isBaseline: boolean; // true if this was the first poll for any restaurant
  summary: string;
}

/**
 * Format a human-readable summary of a poll result.
 */
export function formatPollSummary(diffs: SlotDiff[], isBaseline: boolean): string {
  if (isBaseline) {
    const totalSlots = diffs.reduce((sum, d) => sum + d.totalAvailable, 0);
    const restaurants = diffs.filter((d) => d.totalAvailable > 0).length;
    return `Baseline scan complete: ${totalSlots} slots across ${restaurants} restaurants.`;
  }

  const newTotal = diffs.reduce((sum, d) => sum + d.newSlots.length, 0);
  const droppedTotal = diffs.reduce((sum, d) => sum + d.droppedSlots.length, 0);

  if (newTotal === 0 && droppedTotal === 0) {
    return "No changes detected.";
  }

  const parts: string[] = [];
  if (newTotal > 0) parts.push(`${newTotal} new slot${newTotal !== 1 ? "s" : ""} found`);
  if (droppedTotal > 0) parts.push(`${droppedTotal} slot${droppedTotal !== 1 ? "s" : ""} taken`);
  return parts.join(", ") + ".";
}
