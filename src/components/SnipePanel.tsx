"use client";

import { useState, useEffect, useCallback } from "react";

import type { Restaurant } from "@/data/restaurants";
import type { LogLevel } from "@/lib/logger";

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

interface NotificationConfig {
  email?: { enabled: boolean; to: string; gmailUser: string; gmailAppPassword: string };
  ntfy?: { enabled: boolean; topic: string; server?: string };
}

interface Props {
  restaurants: Restaurant[];
  isAuthenticated: boolean;
  authToken?: string;
  partySize: number;
  dayTimeWindows?: Record<string, { start?: string; end?: string }>;
  preferredDays?: string[];
  notificationConfig?: NotificationConfig;
  onBooked?: (event: Record<string, unknown>) => void;
  onLog?: (level: LogLevel, msg: string, data?: Record<string, unknown>) => void;
}

const TIME_OPTIONS = [
  "10:00", "10:30", "11:00", "11:30", "12:00", "12:30",
  "13:00", "13:30", "14:00", "14:30", "15:00", "15:30",
  "17:00", "17:30", "18:00", "18:30", "19:00", "19:30",
  "20:00", "20:30", "21:00", "21:30", "22:00",
];

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function timesFromWindows(
  dates: string[],
  windows: Record<string, { start?: string; end?: string }>,
): Set<string> {
  const result = new Set<string>();
  for (const date of dates) {
    const dayName = DAY_NAMES[new Date(date + "T12:00:00").getDay()];
    const win = windows[dayName];
    if (!win) continue;
    for (const t of TIME_OPTIONS) {
      if ((!win.start || t >= win.start) && (!win.end || t <= win.end)) result.add(t);
    }
  }
  return result;
}

/** Parse "9:00 AM ET" → "09:00". Returns null if unparseable. */
function parseBookingTimeTo24(bt: string | null | undefined): string | null {
  if (!bt) return null;
  const m = bt.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1]);
  if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
  if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

const DROP_TIME_OPTIONS = [
  "00:00", "08:00", "09:00", "10:00", "11:00", "12:00",
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

// Returns the dining date that will drop when the snipe fires at dropTime (ET).
// Mirrors nextDropTimestamp logic: if dropTime already passed today ET, fires tomorrow.
function getDropDate(restaurant: Restaurant, scheduleDropTime: string): string | null {
  if (!restaurant.advanceDays) return null;
  const [h, m] = scheduleDropTime.split(":").map(Number);
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const todayDropET = new Date(nowET);
  todayDropET.setHours(h, m, 0, 0);
  // If the drop time has already passed today, the snipe fires tomorrow
  const fireDateET = new Date(nowET);
  if (todayDropET.getTime() <= nowET.getTime()) {
    fireDateET.setDate(fireDateET.getDate() + 1);
  }
  fireDateET.setDate(fireDateET.getDate() + restaurant.advanceDays);
  const y = fireDateET.getFullYear();
  const mo = String(fireDateET.getMonth() + 1).padStart(2, "0");
  const d = String(fireDateET.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

export default function SnipePanel({ restaurants, isAuthenticated, authToken, partySize: defaultPartySize, dayTimeWindows, notificationConfig, onLog }: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [snipePartySize, setSnipePartySize] = useState(defaultPartySize);
  const [dates, setDates] = useState<string[]>([]);
  const [datesCustomized, setDatesCustomized] = useState(false);
  const [dateInput, setDateInput] = useState("");
  const [selectedTimes, setSelectedTimes] = useState<Set<string>>(new Set(["19:00", "19:30", "20:00"]));
  const [timesCustomized, setTimesCustomized] = useState(false);
  const [timeRadius, setTimeRadius] = useState(30);
  const [snipeWindow, setSnipeWindow] = useState(90);
  const [scheduleDropTime, setScheduleDropTime] = useState("09:00");
  const [schedulingInProgress, setSchedulingInProgress] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [scheduledSnipes, setScheduledSnipes] = useState<ScheduledSnipe[]>([]);
  const [redisAvailable, setRedisAvailable] = useState<boolean | null>(null);

  // Auto-derive times from settings windows when dates change (unless user customized)
  useEffect(() => {
    if (timesCustomized || !dayTimeWindows || dates.length === 0) return;
    const auto = timesFromWindows(dates, dayTimeWindows);
    if (auto.size > 0) setSelectedTimes(auto);
  }, [dates, dayTimeWindows, timesCustomized]);

  // Auto-set drop time from the selected restaurant's booking window
  useEffect(() => {
    if (selectedIds.size !== 1) return;
    const r = restaurants.find(x => x.id === Array.from(selectedIds)[0]);
    const parsed = parseBookingTimeTo24(r?.bookingTime);
    if (parsed) setScheduleDropTime(parsed);
  }, [selectedIds, restaurants]);

  // Auto-fill target dates from booking windows whenever selection changes (unless user customized)
  useEffect(() => {
    if (selectedIds.size === 0 || datesCustomized) return;
    const drops = new Set<string>();
    for (const id of selectedIds) {
      const r = restaurants.find(x => x.id === id);
      if (r) { const dd = getDropDate(r, scheduleDropTime); if (dd) drops.add(dd); }
    }
    if (drops.size > 0) setDates(Array.from(drops).sort());
  }, [selectedIds, restaurants, datesCustomized, scheduleDropTime]);

  const fetchScheduledSnipes = useCallback(async () => {
    try {
      const res = await fetch("/api/scheduled-snipes");
      if (res.ok) {
        const data = await res.json();
        setScheduledSnipes(data.snipes ?? []);
        setRedisAvailable(!data.warning);
      }
    } catch {
      setRedisAvailable(false);
    }
  }, []);

  // Initial fetch on mount
  useEffect(() => {
    fetchScheduledSnipes();
  }, [fetchScheduledSnipes]);

  // Polling interval — back off to 10 min when Redis is unavailable to avoid log spam
  useEffect(() => {
    if (redisAvailable === null) return;
    const ms = redisAvailable === false ? 10 * 60_000 : 60_000;
    const timer = setInterval(fetchScheduledSnipes, ms);
    return () => clearInterval(timer);
  }, [fetchScheduledSnipes, redisAvailable]);

  const toggleRestaurant = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleTime = (t: string) => {
    setTimesCustomized(true);
    setSelectedTimes(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const addDate = (d: string) => {
    if (d && !dates.includes(d)) {
      setDatesCustomized(true);
      setDates(prev => [...prev, d].sort());
    }
    setDateInput("");
  };

  const removeDate = (d: string) => {
    setDatesCustomized(true);
    setDates(prev => prev.filter(x => x !== d));
  };

  const clearAllRestaurants = () => {
    setSelectedIds(new Set());
  };

  const autoFillDropDates = () => {
    const selected = restaurants.filter(r => selectedIds.has(r.id));
    const dropDates = new Set<string>(dates);
    for (const r of selected) {
      const dd = getDropDate(r, scheduleDropTime);
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
          ...(notificationConfig ? { notificationConfig } : {}),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const names = selectedRestaurants.map(r => r.name).join(", ");
        onLog?.("success", `Snipe scheduled for ${formatTime12(scheduleDropTime)} ET — ${names} · ${dates.length} date(s) · ${selectedTimes.size} time(s)`, { id: data.id, qstashScheduled: data.qstashScheduled });
        if (!data.qstashScheduled) {
          onLog?.("warn", "QStash not configured — snipe saved but won't auto-fire");
        }
        await fetchScheduledSnipes();
        // Reset selection so the user doesn't accidentally schedule again
        setSelectedIds(new Set());
        setDatesCustomized(false);
      } else {
        const errData = await res.json().catch(() => ({}));
        onLog?.("error", `Failed to schedule snipe: ${errData.error ?? res.statusText}`);
      }
    } catch (err) {
      onLog?.("error", `Schedule error: ${err instanceof Error ? err.message : String(err)}`);
    }
    finally { setSchedulingInProgress(false); }
  };

  const removeScheduledSnipe = async (id: string) => {
    try {
      await fetch(`/api/scheduled-snipes?id=${id}`, { method: "DELETE" });
      setScheduledSnipes(prev => prev.filter(s => s.id !== id));
      onLog?.("info", `Snipe ${id.slice(-4)} removed`);
    } catch (err) {
      onLog?.("error", `Failed to remove snipe: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const resyRestaurants = restaurants
    .filter(r => r.resyVenueId)
    .sort((a, b) => (a.advanceDays ?? 0) - (b.advanceDays ?? 0));
  const canSchedule = isAuthenticated && selectedIds.size > 0 && selectedTimes.size > 0 && dates.length > 0 && !!authToken;
  const firstSelected = restaurants.find(r => selectedIds.has(r.id));

  const scheduleLabel = (() => {
    if (!isAuthenticated) return "Auth required";
    if (selectedIds.size === 0) return "Select a restaurant above";
    if (dates.length === 0) return "Select a target date above";
    if (selectedTimes.size === 0) return "Select dining times above";
    const name = firstSelected?.name ?? "";
    const extra = selectedIds.size > 1 ? ` +${selectedIds.size - 1}` : "";
    const dateStr = dates.length === 1 ? formatDateShort(dates[0]) : `${dates.length} dates`;
    return schedulingInProgress ? "Scheduling..." : `Schedule — ${name}${extra}, ${dateStr}`;
  })();

  const sel = (active: boolean) =>
    `w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border-2 text-left transition-all ${
      active ? "border-charcoal bg-charcoal text-white" : "border-stone-100 bg-stone-50 text-charcoal hover:border-stone-300 hover:bg-white"
    }`;

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
      <div className="p-4 space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-serif text-lg text-charcoal">Snipe Mode</h2>
            <p className="text-xs text-stone-400 mt-0.5">Schedule a snipe to fire automatically when reservations drop</p>
          </div>
          {!isAuthenticated && (
            <span className="text-xs text-red-500 bg-red-50 px-2 py-1 rounded-full border border-red-100">Auth required</span>
          )}
        </div>

        {/* Step 1: Restaurant */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="w-5 h-5 rounded-full bg-charcoal text-white text-[10px] flex items-center justify-center font-bold shrink-0">1</span>
            <span className="text-sm font-semibold text-charcoal">
              Which restaurant?
              {selectedIds.size > 0 && <span className="ml-1.5 text-xs font-normal text-stone-400">{selectedIds.size} selected</span>}
            </span>
            {selectedIds.size > 0 && (
              <button onClick={clearAllRestaurants} className="ml-auto text-[10px] text-stone-400 hover:text-stone-600 underline">Clear</button>
            )}
          </div>
          <div className="space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
            {resyRestaurants.map(r => {
              const isSelected = selectedIds.has(r.id);
              const dropDate = getDropDate(r, scheduleDropTime);
              return (
                <button key={r.id} onClick={() => toggleRestaurant(r.id)} className={sel(isSelected)}>
                  <span className="font-medium text-sm truncate">{r.name}</span>
                  <div className="text-right shrink-0 ml-3 leading-tight">
                    <div className={`text-[11px] ${isSelected ? "text-white/60" : "text-stone-400"}`}>
                      {r.bookingTime ? `${r.advanceDays}d @ ${r.bookingTime}` : r.advanceDays ? `${r.advanceDays}d rolling` : ""}
                    </div>
                    {dropDate && (
                      <div className={`text-[11px] font-semibold ${isSelected ? "text-white" : "text-amber-600"}`}>
                        next: {formatDateShort(dropDate)}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Step 2: Target date */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="w-5 h-5 rounded-full bg-charcoal text-white text-[10px] flex items-center justify-center font-bold shrink-0">2</span>
            <span className="text-sm font-semibold text-charcoal">Target dining date</span>
            {selectedIds.size > 0 && dates.length === 0 && (
              <button onClick={autoFillDropDates} className="ml-auto text-[11px] text-amber-600 hover:text-amber-800 font-medium underline">
                Auto-fill from booking window
              </button>
            )}
          </div>
          <div className="flex gap-2 mb-2">
            <input
              type="date"
              value={dateInput}
              onChange={(e) => setDateInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && dateInput) addDate(dateInput); }}
              className="flex-1 px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
            />
            <button onClick={() => addDate(dateInput)} disabled={!dateInput}
              className="px-3 py-2 bg-charcoal text-white rounded-lg text-sm font-medium hover:bg-charcoal/90 disabled:opacity-40">
              Add
            </button>
          </div>
          {dates.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {dates.map(d => (
                <span key={d} className="inline-flex items-center gap-1 bg-stone-100 text-stone-700 px-2.5 py-1 rounded-lg text-xs">
                  {formatDateShort(d)}
                  <button onClick={() => removeDate(d)} className="text-stone-400 hover:text-stone-600">&times;</button>
                </span>
              ))}
              {dates.length > 1 && (
                <button onClick={() => { setDates([]); setDatesCustomized(false); }} className="text-[10px] text-stone-400 hover:text-stone-600 underline px-1">Clear all</button>
              )}
            </div>
          )}
        </div>

        {/* Step 3: Dining times */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="w-5 h-5 rounded-full bg-charcoal text-white text-[10px] flex items-center justify-center font-bold shrink-0">3</span>
            <span className="text-sm font-semibold text-charcoal">Dining times</span>
            <span className="text-[10px] text-stone-400">tap to select</span>
            {timesCustomized && dayTimeWindows && (
              <button
                onClick={() => {
                  const auto = timesFromWindows(dates, dayTimeWindows);
                  if (auto.size > 0) { setSelectedTimes(auto); setTimesCustomized(false); }
                }}
                className="ml-auto text-[10px] text-stone-400 hover:text-stone-600 underline"
              >
                Reset to settings
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {TIME_OPTIONS.map(t => (
              <button key={t} onClick={() => toggleTime(t)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  selectedTimes.has(t) ? "bg-charcoal text-white" : "bg-stone-100 text-stone-500 hover:bg-stone-200"
                }`}>
                {formatTime12(t)}
              </button>
            ))}
          </div>
          {selectedTimes.size === 0 && (
            <p className="text-xs text-stone-400 mt-1.5">Select at least one time above</p>
          )}
        </div>

        {/* Step 4: Drop time */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="w-5 h-5 rounded-full bg-charcoal text-white text-[10px] flex items-center justify-center font-bold shrink-0">4</span>
            <span className="text-sm font-semibold text-charcoal">Drop time (ET)</span>
            <span className="text-[10px] text-stone-400">when Resy opens booking</span>
          </div>
          <select value={scheduleDropTime} onChange={(e) => setScheduleDropTime(e.target.value)}
            className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold/50">
            {[...new Set([...DROP_TIME_OPTIONS, scheduleDropTime])].sort().map(t => (
              <option key={t} value={t}>{formatTime12(t)} ET</option>
            ))}
          </select>
        </div>

        {/* Party size + Advanced toggle */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-stone-500 font-medium">Party:</span>
          {([2, 4] as const).map(size => (
            <button key={size} onClick={() => setSnipePartySize(size)}
              className={`w-9 h-9 rounded-lg text-sm font-semibold transition-colors ${
                snipePartySize === size ? "bg-charcoal text-white" : "bg-stone-100 text-stone-500 hover:bg-stone-200"
              }`}>
              {size}
            </button>
          ))}
          <button onClick={() => setShowAdvanced(v => !v)} className="ml-auto text-[10px] text-stone-400 hover:text-stone-600 underline">
            {showAdvanced ? "Hide advanced" : "Advanced options"}
          </button>
        </div>

        {/* Advanced options */}
        {showAdvanced && (
          <div className="grid grid-cols-2 gap-3 bg-stone-50 border border-stone-100 rounded-xl p-3">
            <div>
              <label className="block text-xs text-stone-500 mb-1">Time flexibility</label>
              <select value={timeRadius} onChange={(e) => setTimeRadius(Number(e.target.value))}
                className="w-full px-2 py-2 border border-stone-200 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-gold/50">
                <option value={15}>±15 min</option>
                <option value={30}>±30 min</option>
                <option value={60}>±60 min</option>
                <option value={120}>±2 hrs</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-stone-500 mb-1">Snipe window</label>
              <select value={snipeWindow} onChange={(e) => setSnipeWindow(Number(e.target.value))}
                className="w-full px-2 py-2 border border-stone-200 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-gold/50">
                <option value={30}>30 sec</option>
                <option value={60}>60 sec</option>
                <option value={90}>90 sec</option>
                <option value={120}>2 min</option>
              </select>
            </div>
          </div>
        )}

        {/* Date mismatch warning: target dates don't align with any restaurant's drop date */}
        {(() => {
          if (selectedIds.size === 0 || dates.length === 0) return null;
          const mismatches = Array.from(selectedIds)
            .map(id => restaurants.find(r => r.id === id))
            .filter((r): r is NonNullable<typeof r> => !!r && !!r.bookingTime && !!r.advanceDays)
            .map(r => {
              const dropDate = getDropDate(r, scheduleDropTime)!;
              return dates.includes(dropDate) ? null : { name: r.name, dropDate, bookingTime: r.bookingTime! };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null);
          if (mismatches.length === 0) return null;
          return (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-3 space-y-1.5">
              <p className="text-xs font-semibold text-amber-800">Date mismatch — slots won&apos;t drop on your target date</p>
              {mismatches.map(m => (
                <p key={m.name} className="text-xs text-amber-700">
                  <span className="font-medium">{m.name}</span> drops <span className="font-medium">{formatDateShort(m.dropDate)}</span> at {m.bookingTime} — that&apos;s not in your target dates. Add {formatDateShort(m.dropDate)} to catch the drop.
                </p>
              ))}
            </div>
          );
        })()}

        {/* Primary action */}
        {redisAvailable === false ? (
          <div className="w-full py-3 text-center text-xs text-stone-400 border border-dashed border-stone-200 rounded-xl">
            Scheduling unavailable — add Upstash Redis env vars
          </div>
        ) : (
          <button onClick={scheduleSnipe} disabled={!canSchedule || schedulingInProgress}
            className="w-full py-3.5 bg-charcoal text-white rounded-xl text-sm font-semibold hover:bg-charcoal/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            {scheduleLabel}
          </button>
        )}

        {/* Scheduled snipes list */}
        {scheduledSnipes.length > 0 && (
          <div className="border border-stone-200 rounded-xl overflow-hidden">
            <div className="bg-stone-50 px-3 py-2 border-b border-stone-200">
              <h3 className="text-xs font-semibold text-stone-600">Scheduled ({scheduledSnipes.length})</h3>
            </div>
            <div className="divide-y divide-stone-100">
              {scheduledSnipes.map(snipe => (
                <div key={snipe.id} className="px-3 py-2.5 flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${
                    snipe.status === "waiting" ? "bg-blue-400 animate-pulse" :
                    snipe.status === "running" ? "bg-amber-400 animate-pulse" :
                    snipe.status === "completed" ? "bg-emerald-500" : "bg-red-400"
                  }`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-stone-700 truncate">
                      {snipe.restaurantNames.slice(0, 3).join(", ")}
                      {snipe.restaurantNames.length > 3 && ` +${snipe.restaurantNames.length - 3}`}
                    </div>
                    <div className="text-[10px] text-stone-400">
                      {snipe.dates.map(d => formatDateShort(d)).join(", ")} · Drop: {formatTime12(snipe.dropTime)} ET
                      {snipe.qstashScheduled && <span className="text-blue-500 ml-1">· server</span>}
                      {snipe.result && <span className="ml-1">· {snipe.result}</span>}
                    </div>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                    snipe.status === "waiting" ? "bg-blue-100 text-blue-600" :
                    snipe.status === "running" ? "bg-amber-100 text-amber-600" :
                    snipe.status === "completed" ? "bg-emerald-100 text-emerald-600" : "bg-red-100 text-red-600"
                  }`}>{snipe.status}</span>
                  {(snipe.status === "waiting" || snipe.status === "completed" || snipe.status === "failed") && (
                    <button onClick={() => removeScheduledSnipe(snipe.id)} className="text-stone-400 hover:text-stone-600 text-xs">&times;</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
