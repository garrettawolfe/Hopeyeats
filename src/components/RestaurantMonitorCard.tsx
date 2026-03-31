"use client";

import type { Restaurant } from "@/data/restaurants";
import type { AvailabilitySlot } from "@/lib/resyApi";

function formatTime12(time24: string): string {
  if (!time24) return "";
  const [h, m] = time24.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// #13: Booking failure info passed from parent
interface BookingFailure {
  time: string;
  error: string;
  timestamp: string;
}

interface Props {
  restaurant: Restaurant;
  slots: AvailabilitySlot[];
  newSlotIds: Set<string>;
  isMonitored: boolean;
  autoBookEnabled: boolean;
  isAuthenticated: boolean;
  onToggleMonitor: (id: string) => void;
  onToggleAutoBook: (id: string) => void;
  onBook: (slot: AvailabilitySlot) => void;
  bookingInProgress: string | null;
  lastChecked: string | null;
  partySize?: number;          // #12: Current party size for filtering display
  lastBookingFailure?: BookingFailure | null;  // #13: Last failure for this restaurant
}

export default function RestaurantMonitorCard({
  restaurant,
  slots,
  newSlotIds,
  isMonitored,
  autoBookEnabled,
  isAuthenticated,
  onToggleMonitor,
  onToggleAutoBook,
  onBook,
  bookingInProgress,
  lastChecked,
  partySize = 2,
  lastBookingFailure,
}: Props) {
  const hasSlots = slots.length > 0;
  const newCount = slots.filter((s) => newSlotIds.has(s.id)).length;

  return (
    <div
      className={`rounded-2xl border overflow-hidden transition-all ${
        hasSlots
          ? "border-emerald-200 bg-white shadow-md"
          : isMonitored
            ? "border-stone-200 bg-white shadow-sm"
            : "border-stone-100 bg-stone-50"
      }`}
    >
      {/* Header */}
      <div className="px-3 sm:px-5 py-3 sm:py-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm sm:text-base font-semibold text-charcoal truncate">
                {restaurant.name}
              </h3>
              {newCount > 0 && (
                <span className="shrink-0 text-[10px] font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded-full animate-pulse">
                  +{newCount} NEW
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-xs text-stone-400">
              <span>{restaurant.neighborhood}</span>
              <span>·</span>
              <span>{restaurant.cuisine}</span>
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              {restaurant.michelinStar && (
                <span className="text-[10px] font-medium text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">
                  Michelin Star
                </span>
              )}
              {restaurant.menuUrl && (
                <a href={restaurant.menuUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-stone-400 hover:text-charcoal underline">Menu</a>
              )}
              {restaurant.instagramUrl && (
                <a href={restaurant.instagramUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-stone-400 hover:text-charcoal underline">IG</a>
              )}
              {restaurant.website && (
                <a href={restaurant.website} target="_blank" rel="noopener noreferrer" className="text-[10px] text-stone-400 hover:text-charcoal underline">Web</a>
              )}
              {restaurant.mapsUrl && (
                <a href={restaurant.mapsUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-stone-400 hover:text-charcoal underline">Map</a>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Auto-book toggle (per restaurant) — always visible when monitored */}
            {isMonitored && (
              <button
                onClick={() => isAuthenticated ? onToggleAutoBook(restaurant.id) : undefined}
                className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                  !isAuthenticated
                    ? "bg-stone-100 text-stone-300 cursor-not-allowed"
                    : autoBookEnabled
                      ? "bg-emerald-500 text-white"
                      : "bg-stone-100 text-stone-400 hover:bg-stone-200"
                }`}
                title={
                  !isAuthenticated
                    ? "Connect Resy account to enable auto-book"
                    : autoBookEnabled
                      ? "Auto-book ON — click to disable"
                      : "Enable auto-book for this restaurant"
                }
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </button>
            )}
            {/* Monitor toggle */}
            <button
              onClick={() => onToggleMonitor(restaurant.id)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                isMonitored
                  ? "bg-charcoal text-white"
                  : "bg-stone-100 text-stone-400 hover:bg-stone-200"
              }`}
              title={isMonitored ? "Stop monitoring" : "Start monitoring"}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {isMonitored ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                )}
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Slots */}
      {hasSlots && (
        <div className="border-t border-stone-100 px-3 sm:px-5 py-3 bg-stone-50/50">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-emerald-700">
              {slots.length} slot{slots.length !== 1 ? "s" : ""} across{" "}
              {new Set(slots.map((s) => s.date)).size} date{new Set(slots.map((s) => s.date)).size !== 1 ? "s" : ""}
            </span>
            {autoBookEnabled && isAuthenticated && (
              <span className="text-[10px] text-emerald-500 bg-emerald-50 px-1.5 py-0.5 rounded">
                Auto-book ON
              </span>
            )}
          </div>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {(() => {
              // Group slots by date
              const byDate = new Map<string, AvailabilitySlot[]>();
              for (const slot of slots) {
                const existing = byDate.get(slot.date) ?? [];
                existing.push(slot);
                byDate.set(slot.date, existing);
              }
              const sortedDates = [...byDate.keys()].sort();

              return sortedDates.map((date) => {
                const dateSlots = byDate.get(date)!;
                return (
                  <div key={date}>
                    <p className="text-[10px] font-semibold text-stone-500 uppercase tracking-wide mb-1">
                      {formatDate(date)}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {dateSlots.map((slot) => {
                        const isNew = newSlotIds.has(slot.id);
                        const isBooking = bookingInProgress === slot.id;
                        return (
                          <a
                            key={slot.id}
                            href={slot.resyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => {
                              if (isAuthenticated) {
                                e.preventDefault();
                                onBook(slot);
                              }
                              // If not authenticated, let the link open Resy
                            }}
                            className={`group relative inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs border cursor-pointer transition-colors ${
                              isBooking
                                ? "bg-amber-50 border-amber-300 text-amber-700"
                                : isNew
                                  ? "bg-emerald-50 border-emerald-300 text-emerald-700 hover:bg-emerald-100"
                                  : "bg-white border-stone-200 text-charcoal hover:bg-stone-50 hover:border-stone-300"
                            }`}
                          >
                            {isNew && (
                              <span className="w-1 h-1 rounded-full bg-emerald-500 shrink-0" />
                            )}
                            <span className="font-medium">{formatTime12(slot.time)}</span>
                            <span className="text-[10px] text-stone-400">{slot.tableType}</span>
                            {/* #12: Show max party if slot can't fit current party */}
                            {slot.maxParty < partySize && (
                              <span className="text-[10px] text-amber-500 font-medium" title={`Max ${slot.maxParty} guests`}>
                                max {slot.maxParty}
                              </span>
                            )}
                            {isBooking && (
                              <span className="text-[10px] text-amber-600 font-medium">Booking...</span>
                            )}
                          </a>
                        );
                      })}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* #13: Persistent booking failure banner (stays until next success) */}
      {lastBookingFailure && (
        <div className="border-t border-red-100 px-3 sm:px-5 py-2 bg-red-50/50">
          <p className="text-[10px] text-red-600 truncate" title={lastBookingFailure.error}>
            Last auto-book failed: {lastBookingFailure.error}
          </p>
        </div>
      )}

      {/* #14: Auto-book explanation when not authenticated */}
      {isMonitored && !isAuthenticated && (
        <div className="border-t border-amber-100 px-3 sm:px-5 py-2 bg-amber-50/30">
          <p className="text-[10px] text-amber-600">
            Connect your Resy account in Settings to enable auto-booking
          </p>
        </div>
      )}

      {/* Footer: status */}
      {isMonitored && !hasSlots && (
        <div className="border-t border-stone-100 px-3 sm:px-5 py-2.5">
          <p className="text-[10px] text-stone-400">
            {lastChecked
              ? `No openings · Checked ${new Date(lastChecked).toLocaleTimeString()}`
              : "Waiting for first scan..."}
          </p>
        </div>
      )}
    </div>
  );
}
