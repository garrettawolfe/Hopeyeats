"use client";

import { useState, useRef, useEffect, useCallback } from "react";

import type { Restaurant } from "@/data/restaurants";

interface SnipeEvent {
  type: string;
  [key: string]: unknown;
}

interface ScheduledSnipe {
  id: string;
  restaurantIds: string[];
  restaurantNames: string[];
  dates: string[];
  preferredTimes: string[];
  timeRadius: number;
  snipeWindowSeconds: number;
  partySize: number;
  dropTime: string; // "HH:MM" in ET — when to auto-launch
  status: "waiting" | "running" | "completed" | "failed";
  result?: string;
  qstashScheduled?: boolean;
}

export interface SnipeWatchTarget {
  restaurantId: string;
  restaurantName: string;
  dates: string[];
  preferredTimes: string[];
  timeRadius: number;
}

interface Props {
  restaurants: Restaurant[];
  isAuthenticated: boolean;
  authToken?: string;
  partySize: number;
  onBooked?: (event: SnipeEvent) => void;
  onWatchTargetsChange?: (targets: SnipeWatchTarget[]) => void;
}

const TIME_OPTIONS = [
  "17:00", "17:30", "18:00", "18:30", "19:00", "19:30",
  "20:00", "20:30", "21:00", "21:30", "22:00",
];

const DROP_TIME_OPTIONS = [
  "08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00",
];

function formatTime12(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function getDropDate(restaurant: Restaurant): string | null {
  if (!restaurant.advanceDays) return null;
  const d = new Date();
  d.setDate(d.getDate() + restaurant.advanceDays);
  return d.toISOString().split("T")[0];
}

// Server-side scheduling via Upstash Redis + QStash

export default function SnipePanel({ restaurants, isAuthenticated, authToken, partySize: defaultPartySize, onBooked, onWatchTargetsChange }: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [snipePartySize, setSnipePartySize] = useState(defaultPartySize);
  const [dates, setDates] = useState<string[]>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return [d.toISOString().split("T")[0]];
  });
  const [dateInput, setDateInput] = useState("");
  const [selectedTimes, setSelectedTimes] = useState<Set<string>>(new Set(["19:00", "19:30", "20:00"]));
  const [timeRadius, setTimeRadius] = useState(30);
  const [snipeWindow, setSnipeWindow] = useState(60);
  const [isRunning, setIsRunning] = useState(false);
  const [events, setEvents] = useState<SnipeEvent[]>([]);
  const [result, setResult] = useState<"success" | "failed" | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Server-side scheduled snipes
  const [scheduledSnipes, setScheduledSnipes] = useState<ScheduledSnipe[]>([]);
  const [showScheduler, setShowScheduler] = useState(false);
  const [scheduleDropTime, setScheduleDropTime] = useState("09:00");
  const [schedulingInProgress, setSchedulingInProgress] = useState(false);

  // Fetch scheduled snipes from server on mount + periodically
  const fetchScheduledSnipes = useCallback(async () => {
    try {
      const res = await fetch("/api/scheduled-snipes");
      if (res.ok) {
        const data = await res.json();
        setScheduledSnipes(data.snipes ?? []);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchScheduledSnipes();
    const timer = setInterval(fetchScheduledSnipes, 30_000); // refresh every 30s
    return () => clearInterval(timer);
  }, [fetchScheduledSnipes]);

  // Emit watch targets to parent whenever selection/dates/times change
  // so the monitor can watch for cancellation slots matching snipe criteria
  useEffect(() => {
    if (!onWatchTargetsChange || selectedIds.size === 0 || dates.length === 0 || selectedTimes.size === 0) {
      onWatchTargetsChange?.([]);
      return;
    }
    const targets: SnipeWatchTarget[] = Array.from(selectedIds).map(id => {
      const r = restaurants.find(x => x.id === id);
      return {
        restaurantId: id,
        restaurantName: r?.name ?? id,
        dates: [...dates],
        preferredTimes: Array.from(selectedTimes).sort(),
        timeRadius,
      };
    });
    onWatchTargetsChange(targets);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds.size, dates.length, selectedTimes.size, timeRadius]);

  const toggleRestaurant = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);

      // Auto-fill drop dates and times when adding restaurants
      if (next.has(id)) {
        const r = restaurants.find(x => x.id === id);
        if (r) {
          // Auto-add drop date if restaurant has advanceDays
          const dropDate = getDropDate(r);
          if (dropDate && !dates.includes(dropDate)) {
            setDates(prev => [...prev, dropDate].sort());
          }
          // Auto-set drop time from restaurant's bookingTime
          if (r.bookingTime) {
            const parsed = parseBookingTime(r.bookingTime);
            if (parsed) setScheduleDropTime(parsed);
          }
        }
      }
      return next;
    });
  };

  /** Parse "9:00 AM ET" → "09:00" */
  function parseBookingTime(bt: string): string | null {
    const match = bt.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return null;
    let h = parseInt(match[1]);
    const m = match[2];
    const ampm = match[3].toUpperCase();
    if (ampm === "PM" && h < 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${m}`;
  }

  const toggleTime = (t: string) => {
    setSelectedTimes(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const addDate = (d: string) => {
    if (d && !dates.includes(d)) {
      setDates(prev => [...prev, d].sort());
    }
    setDateInput("");
  };

  const removeDate = (d: string) => {
    setDates(prev => prev.filter(x => x !== d));
  };

  const selectAllRestaurants = () => {
    setSelectedIds(new Set(restaurants.filter(r => r.resyVenueId).map(r => r.id)));
  };

  const clearAllRestaurants = () => {
    setSelectedIds(new Set());
  };

  // Auto-fill dates from selected restaurant drop windows
  const autoFillDropDates = () => {
    const selected = restaurants.filter(r => selectedIds.has(r.id));
    const dropDates = new Set<string>(dates);
    for (const r of selected) {
      const dd = getDropDate(r);
      if (dd) dropDates.add(dd);
    }
    setDates(Array.from(dropDates).sort());
  };

  const scheduleSnipe = async () => {
    if (selectedIds.size === 0 || dates.length === 0 || selectedTimes.size === 0 || !authToken) return;
    setSchedulingInProgress(true);

    try {
      const selectedRestaurants = restaurants.filter(r => selectedIds.has(r.id));
      const res = await fetch("/api/scheduled-snipes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restaurantIds: Array.from(selectedIds),
          restaurantNames: selectedRestaurants.map(r => r.name),
          dates: [...dates],
          preferredTimes: Array.from(selectedTimes).sort(),
          timeRadius,
          snipeWindowSeconds: snipeWindow,
          partySize: snipePartySize,
          dropTime: scheduleDropTime,
          authToken,
        }),
      });

      if (res.ok) {
        setShowScheduler(false);
        await fetchScheduledSnipes();
      }
    } catch { /* silent */ }
    finally { setSchedulingInProgress(false); }
  };

  const removeScheduledSnipe = async (id: string) => {
    try {
      await fetch(`/api/scheduled-snipes?id=${id}`, { method: "DELETE" });
      setScheduledSnipes(prev => prev.filter(s => s.id !== id));
    } catch { /* silent */ }
  };

  const launchSnipe = async () => {
    if (selectedIds.size === 0 || selectedTimes.size === 0 || dates.length === 0) return;

    setIsRunning(true);
    setEvents([]);
    setResult(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/resy-snipe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restaurantIds: Array.from(selectedIds),
          dates,
          partySize: snipePartySize,
          preferredTimes: Array.from(selectedTimes).sort(),
          timeRadius,
          snipeWindowSeconds: snipeWindow,
          pollIntervalMs: 300,
          authToken,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "Request failed" }));
        setEvents(prev => [...prev, { type: "error", error: err.error ?? "Request failed" }]);
        setResult("failed");
        setIsRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event: SnipeEvent = JSON.parse(line);
            setEvents(prev => [...prev, event]);

            if (event.type === "booked") {
              setResult("success");
              onBooked?.(event);
            } else if (event.type === "done" && !event.booked) {
              setResult("failed");
            }

            setTimeout(() => {
              logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
            }, 50);
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setEvents(prev => [...prev, { type: "cancelled" }]);
      } else {
        setEvents(prev => [...prev, { type: "error", error: String(err) }]);
      }
      setResult("failed");
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  };

  const cancelSnipe = () => {
    abortRef.current?.abort();
  };

  const getEventIcon = (type: string) => {
    switch (type) {
      case "started": return "\u{1F680}";
      case "attempt": return "\u{1F50D}";
      case "slots_found": return "\u2728";
      case "booked": return "\u2705";
      case "book_failed": return "\u274C";
      case "error": return "\u26A0\uFE0F";
      case "done": return "\u{1F3C1}";
      case "cancelled": return "\u{1F6D1}";
      default: return "\u2022";
    }
  };

  const getEventText = (event: SnipeEvent): string => {
    switch (event.type) {
      case "started": {
        const targets = event.targets as string[];
        const ds = event.dates as string[] | undefined;
        const dateStr = ds && ds.length > 1 ? `${ds.length} dates` : String(event.date ?? ds?.[0] ?? "");
        return `Targeting ${targets?.join(", ")} on ${dateStr}`;
      }
      case "attempt":
        return `Attempt #${event.attempt} (${Math.round(Number(event.elapsed) / 1000)}s)`;
      case "slots_found":
        return `${event.restaurant} (${event.date}): ${event.count} slots, best: ${formatTime12(String(event.bestTime))}`;
      case "booked":
        return `BOOKED! ${event.restaurant} at ${formatTime12(String(event.time))} on ${event.date}`;
      case "book_failed":
        return `${event.restaurant} ${formatTime12(String(event.time))}: ${event.error}`;
      case "error":
        return `Error: ${event.error}`;
      case "done":
        return `Finished \u2014 ${event.attempts} attempts in ${Math.round(Number(event.elapsed) / 1000)}s across ${event.datesSearched ?? 1} date(s)`;
      case "cancelled":
        return "Snipe cancelled";
      default:
        return JSON.stringify(event);
    }
  };

  const resyRestaurants = restaurants.filter(r => r.resyVenueId);

  // Build drop info for selected restaurants
  const selectedRestaurantInfo = restaurants.filter(r => selectedIds.has(r.id));
  const dropInfoItems = selectedRestaurantInfo
    .filter(r => r.bookingTime || r.advanceDays)
    .map(r => ({
      name: r.name,
      advanceDays: r.advanceDays,
      bookingTime: r.bookingTime,
      dropDate: getDropDate(r),
    }));

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-lg text-charcoal">Snipe Mode</h2>
          <div className="flex items-center gap-2">
            {!isAuthenticated && (
              <span className="text-xs text-red-500 bg-red-50 px-2 py-1 rounded-full">Auth required</span>
            )}
          </div>
        </div>

        {/* Cancellation Watch Status */}
        {selectedIds.size > 0 && dates.length > 0 && selectedTimes.size > 0 && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <span className="text-xs text-emerald-700">
              <span className="font-medium">Cancellation watch active</span> — monitor is watching {selectedIds.size} restaurant{selectedIds.size !== 1 ? "s" : ""} for cancellation slots on {dates.length} date{dates.length !== 1 ? "s" : ""}
            </span>
          </div>
        )}

        {/* Quick Drop Snipe Setup */}
        <div className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-xl p-3">
          <h3 className="text-xs font-semibold text-amber-800 mb-2">Quick Drop Snipe</h3>
          <p className="text-[10px] text-amber-600 mb-2">Click a restaurant to auto-setup a snipe for its next reservation drop.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-48 overflow-y-auto">
            {resyRestaurants.filter(r => r.bookingTime && r.advanceDays).map(r => {
              const dropDate = getDropDate(r);
              const isSelected = selectedIds.has(r.id);
              return (
                <button
                  key={r.id}
                  onClick={() => {
                    if (!isSelected) {
                      // One-click setup: select restaurant, add drop date, set drop time
                      setSelectedIds(prev => new Set([...prev, r.id]));
                      if (dropDate && !dates.includes(dropDate)) {
                        setDates(prev => [...prev, dropDate].sort());
                      }
                      const parsed = parseBookingTime(r.bookingTime!);
                      if (parsed) setScheduleDropTime(parsed);
                    } else {
                      setSelectedIds(prev => { const next = new Set(prev); next.delete(r.id); return next; });
                    }
                  }}
                  disabled={isRunning}
                  className={`text-left px-2.5 py-2 rounded-lg text-xs transition-colors ${
                    isSelected ? "bg-amber-200 text-amber-900 font-medium" : "bg-white/70 text-stone-600 hover:bg-white"
                  }`}
                >
                  <div className="font-medium truncate">{r.name}</div>
                  <div className="text-[10px] opacity-70">
                    {r.bookingTime} &middot; {r.advanceDays}d
                    {dropDate && ` &middot; ${formatDateShort(dropDate)}`}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Restaurant Selection (manual) */}
        <details className="group">
          <summary className="flex items-center justify-between cursor-pointer text-xs text-stone-500 font-medium py-1">
            <span>All Restaurants ({selectedIds.size} selected)</span>
            <div className="flex gap-2">
              <button onClick={(e) => { e.preventDefault(); selectAllRestaurants(); }} disabled={isRunning} className="text-[10px] text-stone-400 hover:text-stone-600 underline">All</button>
              <button onClick={(e) => { e.preventDefault(); clearAllRestaurants(); }} disabled={isRunning} className="text-[10px] text-stone-400 hover:text-stone-600 underline">Clear</button>
            </div>
          </summary>
          <div className="max-h-40 overflow-y-auto border border-stone-200 rounded-lg p-2 space-y-0.5 mt-1">
            {resyRestaurants.map(r => (
              <label
                key={r.id}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-sm transition-colors ${
                  selectedIds.has(r.id) ? "bg-gold/10 text-charcoal" : "text-stone-500 hover:bg-stone-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(r.id)}
                  onChange={() => toggleRestaurant(r.id)}
                  disabled={isRunning}
                  className="rounded border-stone-300 text-charcoal focus:ring-gold"
                />
                <span className="truncate">{r.name}</span>
                <span className="text-[10px] text-stone-400 ml-auto shrink-0">
                  {r.bookingTime ? `${r.advanceDays}d @ ${r.bookingTime}` : `${r.advanceDays}d rolling`}
                </span>
              </label>
            ))}
          </div>
        </details>

        {/* Drop Time Info (when restaurants are selected) */}
        {dropInfoItems.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-amber-800">Reservation Drop Schedule</h3>
              <button
                onClick={autoFillDropDates}
                disabled={isRunning}
                className="text-[10px] bg-amber-200 text-amber-800 px-2 py-0.5 rounded-full hover:bg-amber-300 transition-colors font-medium"
              >
                Auto-fill drop dates
              </button>
            </div>
            <div className="space-y-1">
              {dropInfoItems.map(item => (
                <div key={item.name} className="flex items-center justify-between text-xs">
                  <span className="text-amber-700 truncate">{item.name}</span>
                  <span className="text-amber-600 shrink-0 ml-2">
                    {item.bookingTime ?? "Rolling"} &middot; {item.advanceDays}d ahead
                    {item.dropDate && <span className="text-amber-800 font-medium"> &middot; next: {formatDateShort(item.dropDate)}</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Multi-Date Picker */}
        <div>
          <label className="block text-xs text-stone-500 font-medium mb-1.5">Target Dates ({dates.length})</label>
          <div className="flex gap-2 mb-2">
            <input
              type="date"
              value={dateInput}
              onChange={(e) => setDateInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && dateInput) addDate(dateInput); }}
              className="flex-1 px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
              disabled={isRunning}
            />
            <button
              onClick={() => addDate(dateInput)}
              disabled={isRunning || !dateInput}
              className="px-3 py-2 bg-charcoal text-white rounded-lg text-sm font-medium hover:bg-charcoal/90 transition-colors disabled:opacity-40"
            >
              Add
            </button>
          </div>
          {dates.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {dates.map(d => (
                <span
                  key={d}
                  className="inline-flex items-center gap-1 bg-stone-100 text-stone-700 px-2.5 py-1 rounded-lg text-xs"
                >
                  {formatDateShort(d)}
                  <button
                    onClick={() => removeDate(d)}
                    disabled={isRunning}
                    className="text-stone-400 hover:text-stone-600 ml-0.5"
                  >
                    &times;
                  </button>
                </span>
              ))}
              {dates.length > 1 && (
                <button
                  onClick={() => setDates([])}
                  disabled={isRunning}
                  className="text-[10px] text-stone-400 hover:text-stone-600 underline px-1"
                >
                  Clear all
                </button>
              )}
            </div>
          )}
        </div>

        {/* Config Row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-stone-500 mb-1">Flexibility</label>
            <select
              value={timeRadius}
              onChange={(e) => setTimeRadius(Number(e.target.value))}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
              disabled={isRunning}
            >
              <option value={15}>&plusmn;15 min</option>
              <option value={30}>&plusmn;30 min</option>
              <option value={60}>&plusmn;60 min</option>
              <option value={120}>&plusmn;2 hrs</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-stone-500 mb-1">Snipe Window</label>
            <select
              value={snipeWindow}
              onChange={(e) => setSnipeWindow(Number(e.target.value))}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
              disabled={isRunning}
            >
              <option value={15}>15 sec</option>
              <option value={30}>30 sec</option>
              <option value={60}>60 sec</option>
              <option value={120}>2 min</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-stone-500 mb-1">Party Size</label>
            <div className="flex gap-1">
              {([2, 4] as const).map(size => (
                <button
                  key={size}
                  onClick={() => setSnipePartySize(size)}
                  disabled={isRunning}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                    snipePartySize === size
                      ? "bg-charcoal text-white"
                      : "bg-stone-100 text-stone-500 hover:bg-stone-200"
                  }`}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Preferred Times */}
        <div>
          <label className="block text-xs text-stone-500 font-medium mb-1.5">Preferred Times</label>
          <div className="flex flex-wrap gap-1.5">
            {TIME_OPTIONS.map(t => (
              <button
                key={t}
                onClick={() => toggleTime(t)}
                disabled={isRunning}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  selectedTimes.has(t)
                    ? "bg-charcoal text-white"
                    : "bg-stone-100 text-stone-500 hover:bg-stone-200"
                }`}
              >
                {formatTime12(t)}
              </button>
            ))}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2">
          {!isRunning ? (
            <>
              <button
                onClick={launchSnipe}
                disabled={!isAuthenticated || selectedIds.size === 0 || selectedTimes.size === 0 || dates.length === 0}
                className="flex-1 py-3 bg-charcoal text-white rounded-xl text-sm font-semibold hover:bg-charcoal/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Launch Now ({selectedIds.size} restaurant{selectedIds.size !== 1 ? "s" : ""}, {dates.length} date{dates.length !== 1 ? "s" : ""})
              </button>
              <button
                onClick={() => setShowScheduler(!showScheduler)}
                disabled={!isAuthenticated || selectedIds.size === 0 || selectedTimes.size === 0 || dates.length === 0}
                className="px-4 py-3 border-2 border-charcoal text-charcoal rounded-xl text-sm font-semibold hover:bg-stone-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Schedule snipe for a specific drop time"
              >
                Schedule
              </button>
            </>
          ) : (
            <button
              onClick={cancelSnipe}
              className="flex-1 py-3 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 transition-colors"
            >
              Cancel Snipe
            </button>
          )}
        </div>

        {/* Schedule Picker */}
        {showScheduler && (
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-3">
            <h3 className="text-sm font-semibold text-blue-800">Schedule Snipe</h3>
            <p className="text-xs text-blue-600">
              Auto-launch this snipe at a specific time (ET). Runs server-side via Upstash QStash — no need to keep your browser open.
            </p>
            <div className="flex items-center gap-3">
              <label className="text-xs text-blue-700">Drop time (ET):</label>
              <select
                value={scheduleDropTime}
                onChange={(e) => setScheduleDropTime(e.target.value)}
                className="px-3 py-2 border border-blue-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 bg-white"
              >
                {DROP_TIME_OPTIONS.map(t => (
                  <option key={t} value={t}>{formatTime12(t)} ET</option>
                ))}
              </select>
              <button
                onClick={scheduleSnipe}
                disabled={schedulingInProgress || !authToken}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {schedulingInProgress ? "Scheduling..." : "Confirm Schedule"}
              </button>
            </div>
          </div>
        )}

        {/* Scheduled Snipes List */}
        {scheduledSnipes.length > 0 && (
          <div className="border border-stone-200 rounded-xl overflow-hidden">
            <div className="bg-stone-50 px-3 py-2 border-b border-stone-200">
              <h3 className="text-xs font-semibold text-stone-600">Scheduled Snipes</h3>
            </div>
            <div className="divide-y divide-stone-100">
              {scheduledSnipes.map(snipe => (
                <div key={snipe.id} className="px-3 py-2.5 flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${
                    snipe.status === "waiting" ? "bg-blue-400 animate-pulse" :
                    snipe.status === "running" ? "bg-amber-400 animate-pulse" :
                    snipe.status === "completed" ? "bg-emerald-500" :
                    "bg-red-400"
                  }`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-stone-700 truncate">
                      {snipe.restaurantNames.slice(0, 3).join(", ")}
                      {snipe.restaurantNames.length > 3 && ` +${snipe.restaurantNames.length - 3}`}
                    </div>
                    <div className="text-[10px] text-stone-400">
                      {snipe.dates.map(d => formatDateShort(d)).join(", ")} &middot; Drop: {formatTime12(snipe.dropTime)} ET
                      {snipe.qstashScheduled && <span className="text-blue-500 ml-1">&middot; server-side</span>}
                      {snipe.result && <span className="ml-1">&middot; {snipe.result}</span>}
                    </div>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                    snipe.status === "waiting" ? "bg-blue-100 text-blue-600" :
                    snipe.status === "running" ? "bg-amber-100 text-amber-600" :
                    snipe.status === "completed" ? "bg-emerald-100 text-emerald-600" :
                    "bg-red-100 text-red-600"
                  }`}>
                    {snipe.status}
                  </span>
                  {(snipe.status === "waiting" || snipe.status === "completed" || snipe.status === "failed") && (
                    <button
                      onClick={() => removeScheduledSnipe(snipe.id)}
                      className="text-stone-400 hover:text-stone-600 text-xs"
                    >
                      &times;
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Event Log */}
      {events.length > 0 && (
        <div className="border-t border-stone-200">
          <div
            ref={logRef}
            className="max-h-48 overflow-y-auto p-3 space-y-1 bg-stone-50 font-mono text-xs"
          >
            {events.map((event, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 ${
                  event.type === "booked" ? "text-emerald-600 font-bold" :
                  event.type === "error" || event.type === "book_failed" ? "text-red-500" :
                  event.type === "slots_found" ? "text-blue-600" :
                  "text-stone-500"
                }`}
              >
                <span className="shrink-0">{getEventIcon(event.type)}</span>
                <span>{getEventText(event)}</span>
              </div>
            ))}
          </div>

          {result === "success" && (
            <div className="px-4 py-3 bg-emerald-50 border-t border-emerald-200 text-emerald-700 text-sm font-medium text-center">
              Reservation booked successfully!
            </div>
          )}
          {result === "failed" && !isRunning && (
            <div className="px-4 py-3 bg-red-50 border-t border-red-200 text-red-600 text-sm text-center">
              No reservation booked. Try adjusting times, dates, or restaurants.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
