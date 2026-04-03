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
  partySize?: number;
  lastBookingFailure?: BookingFailure | null;
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
  const hasFitSlots = slots.some(s => s.maxParty >= partySize);

  return (
    <div
      className={`relative rounded-2xl overflow-hidden transition-all duration-200 ${
        hasSlots && hasFitSlots
          ? "bg-white border border-emerald-100 shadow-[0_4px_24px_rgba(16,185,129,0.10)]"
          : hasSlots
            ? "bg-white border border-stone-200 shadow-[0_2px_12px_rgba(0,0,0,0.06)]"
            : isMonitored
              ? "bg-white border border-stone-200 shadow-sm"
              : "bg-stone-50/80 border border-stone-100"
      }`}
    >
      {/* Colored left accent bar */}
      {hasSlots && (
        <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${hasFitSlots ? "bg-emerald-500" : "bg-stone-300"}`} />
      )}

      {/* Card header */}
      <div className="px-4 sm:px-5 pt-4 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className={`text-sm font-semibold truncate ${isMonitored ? "text-stone-900" : "text-stone-400"}`}>
                {restaurant.name}
              </h3>
              {newCount > 0 && (
                <span className="shrink-0 text-[10px] font-bold text-white bg-emerald-500 px-2 py-0.5 rounded-full animate-pulse">
                  +{newCount} new
                </span>
              )}
              {autoBookEnabled && isAuthenticated && (
                <span className="shrink-0 text-[10px] font-semibold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">
                  ⚡ Auto
                </span>
              )}
            </div>
            <p className={`text-xs mt-0.5 ${isMonitored ? "text-stone-400" : "text-stone-300"}`}>
              {restaurant.neighborhood} · {restaurant.cuisine}
            </p>
            <div className="flex items-center gap-2 mt-1.5">
              {restaurant.michelinStar && (
                <span className="text-[10px] font-medium text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-md">★ Michelin</span>
              )}
              {restaurant.instagramUrl && (
                <a href={restaurant.instagramUrl} target="_blank" rel="noopener noreferrer"
                  className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors">IG</a>
              )}
              {restaurant.website && (
                <a href={restaurant.website} target="_blank" rel="noopener noreferrer"
                  className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors">Web</a>
              )}
              {restaurant.mapsUrl && (
                <a href={restaurant.mapsUrl} target="_blank" rel="noopener noreferrer"
                  className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors">Map</a>
              )}
              {restaurant.menuUrl && (
                <a href={restaurant.menuUrl} target="_blank" rel="noopener noreferrer"
                  className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors">Menu</a>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {isMonitored && (
              <button
                onClick={() => isAuthenticated ? onToggleAutoBook(restaurant.id) : undefined}
                className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                  !isAuthenticated
                    ? "bg-stone-100 text-stone-300 cursor-not-allowed"
                    : autoBookEnabled
                      ? "bg-indigo-600 text-white shadow-sm shadow-indigo-200"
                      : "bg-stone-100 text-stone-400 hover:bg-stone-200"
                }`}
                title={
                  !isAuthenticated ? "Connect Resy to enable auto-book"
                    : autoBookEnabled ? "Auto-book ON — click to disable"
                    : "Enable auto-book"
                }
              >
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </button>
            )}
            <button
              onClick={() => onToggleMonitor(restaurant.id)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                isMonitored
                  ? "bg-stone-900 text-white"
                  : "bg-stone-100 text-stone-400 hover:bg-stone-200"
              }`}
              title={isMonitored ? "Stop monitoring" : "Monitor this restaurant"}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {isMonitored ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                )}
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Slots */}
      {hasSlots && (
        <div className="px-4 sm:px-5 pb-4">
          <div className="flex items-center justify-between mb-2.5">
            <span className={`text-xs font-semibold ${hasFitSlots ? "text-emerald-600" : "text-stone-400"}`}>
              {slots.length} slot{slots.length !== 1 ? "s" : ""} · {new Set(slots.map(s => s.date)).size} date{new Set(slots.map(s => s.date)).size !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="space-y-3 max-h-60 overflow-y-auto">
            {(() => {
              const byDate = new Map<string, AvailabilitySlot[]>();
              for (const slot of slots) {
                const existing = byDate.get(slot.date) ?? [];
                existing.push(slot);
                byDate.set(slot.date, existing);
              }
              const sortedDates = [...byDate.keys()].sort();

              return sortedDates.map((date) => {
                const dateSlots = (byDate.get(date) ?? []).slice().sort((a, b) => {
                  const aFits = a.maxParty >= partySize ? 1 : 0;
                  const bFits = b.maxParty >= partySize ? 1 : 0;
                  if (aFits !== bFits) return bFits - aFits;
                  return a.time.localeCompare(b.time);
                });
                return (
                  <div key={date}>
                    <p className="text-[10px] font-semibold text-stone-400 uppercase tracking-widest mb-1.5">
                      {formatDate(date)}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {dateSlots.map((slot) => {
                        const isNew = newSlotIds.has(slot.id);
                        const isBooking = bookingInProgress === slot.id;
                        const fitsParty = slot.maxParty >= partySize;
                        return (
                          <a
                            key={slot.id}
                            href={slot.resyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => {
                              if (isAuthenticated) { e.preventDefault(); onBook(slot); }
                            }}
                            title={!fitsParty ? `Max ${slot.maxParty} guests` : slot.tableType}
                            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-semibold cursor-pointer select-none transition-all ${
                              isBooking
                                ? "bg-amber-400 text-white animate-pulse"
                                : isNew && fitsParty
                                  ? "bg-emerald-500 text-white ring-2 ring-emerald-200 hover:bg-emerald-600"
                                  : fitsParty
                                    ? "bg-stone-800 text-white hover:bg-stone-700"
                                    : "bg-stone-100 text-stone-400 hover:bg-stone-200"
                            }`}
                          >
                            <span>{formatTime12(slot.time)}</span>
                            {!fitsParty && (
                              <span className="text-[9px] opacity-70">·{slot.maxParty}</span>
                            )}
                            {isBooking && <span>…</span>}
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

      {/* Booking failure */}
      {lastBookingFailure && (
        <div className="border-t border-red-100 px-4 sm:px-5 py-2 bg-red-50/60 border-l-2 border-l-red-400">
          <p className="text-[10px] text-red-600 truncate" title={lastBookingFailure.error}>
            Auto-book failed: {lastBookingFailure.error}
          </p>
        </div>
      )}

      {/* No-auth nudge */}
      {isMonitored && !isAuthenticated && (
        <div className="border-t border-amber-100 px-4 sm:px-5 py-2">
          <p className="text-[10px] text-amber-600">Connect Resy in Settings to enable auto-booking</p>
        </div>
      )}

      {/* Empty state footer */}
      {isMonitored && !hasSlots && (
        <div className="px-4 sm:px-5 pb-3.5">
          <p className="text-[11px] text-stone-400">
            {lastChecked
              ? `No openings · ${new Date(lastChecked).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
              : "Waiting for first scan…"}
          </p>
        </div>
      )}
    </div>
  );
}
