"use client";

import { useState, useRef, useEffect, useCallback } from "react";

import type { Restaurant } from "@/data/restaurants";
import type { LogLevel } from "@/lib/logger";

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

interface Props {
  restaurants: Restaurant[];
  isAuthenticated: boolean;
  authToken?: string;
  partySize: number;
  dayTimeWindows?: Record<string, { start?: string; end?: string }>;
  preferredDays?: string[];
  onBooked?: (event: SnipeEvent) => void;
  onLog?: (level: LogLevel, msg: string, data?: Record<string, unknown>) => void;
}

const TIME_OPTIONS = [
  "17:00", "17:30", "18:00", "18:30", "19:00", "19:30",
  "20:00", "20:30", "21:00", "21:30", "22:00",
];

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Return times from TIME_OPTIONS that fall within the window for any of the given dates. */
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

function getDropDate(restaurant: Restaurant): string | null {
  if (!restaurant.advanceDays) return null;
  const d = new Date();
  d.setDate(d.getDate() + restaurant.advanceDays);
  return d.toISOString().split("T")[0];
}

export default function SnipePanel({ restaurants, isAuthenticated, authToken, partySize: defaultPartySize, dayTimeWindows, onBooked, onLog }: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [snipePartySize, setSnipePartySize] = useState(defaultPartySize);
  const [dates, setDates] = useState<string[]>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return [d.toISOString().split("T")[0]];
  });
  const [dateInput, setDateInput] = useState("");
  const [selectedTimes, setSelectedTimes] = useState<Set<string>>(new Set(["19:00", "19:30", "20:00"]));
  const [timesCustomized, setTimesCustomized] = useState(false);
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
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Auto-derive preferred dinner times from settings windows when dates change
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

  // Auto-fill target dates from booking windows when restaurants are first selected
  useEffect(() => {
    if (selectedIds.size === 0) return;
    setDates(prev => {
      if (prev.length > 0) return prev;
      const drops = new Set<string>();
      for (const id of selectedIds) {
        const r = restaurants.find(x => x.id === id);
        if (r) { const dd = getDropDate(r); if (dd) drops.add(dd); }
      }
      return drops.size > 0 ? Array.from(drops).sort() : prev;
    });
  }, [selectedIds, restaurants]);

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

            if (event.type === "started") {
              onLog?.("info", `Snipe started — targets: ${(event.targets as string[])?.join(", ")}`, { dates: event.dates });
            } else if (event.type === "attempt") {
              if (Number(event.attempt) % 5 === 1) {
                onLog?.("debug", `Snipe attempt #${event.attempt} (${Math.round(Number(event.elapsed) / 1000)}s elapsed)`);
              }
            } else if (event.type === "slots_found") {
              onLog?.("info", `Slots found — ${event.restaurant} on ${event.date}: ${event.count} slots`, { bestTime: event.bestTime });
            } else if (event.type === "booked") {
              onLog?.("success", `BOOKED — ${event.restaurant} ${event.date} at ${event.time}`, { reservationId: event.reservationId });
              setResult("success");
              onBooked?.(event);
            } else if (event.type === "book_failed") {
              onLog?.("error", `Book failed — ${event.restaurant}: ${event.error}`, { error: event.error });
            } else if (event.type === "error") {
              onLog?.("error", `Snipe error: ${event.error}`);
            } else if (event.type === "done") {
              onLog?.(event.booked ? "success" : "info", `Snipe done`, { booked: event.booked, elapsed: event.elapsed });
              if (!event.booked) setResult("failed");
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
        onLog?.("warn", "Snipe cancelled by user");
      } else {
        setEvents(prev => [...prev, { type: "error", error: String(err) }]);
        onLog?.("error", `Snipe stream error: ${String(err)}`);
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
  const canLaunch = isAuthenticated && selectedIds.size > 0 && selectedTimes.size > 0 && dates.length > 0;
  const firstSelected = restaurants.find(r => selectedIds.has(r.id));
  const launchLabel = (() => {
    if (selectedIds.size === 0) return "Select a restaurant above";
    if (dates.length === 0) return "Select a target date above";
    const name = firstSelected?.name ?? "";
    const extra = selectedIds.size > 1 ? ` +${selectedIds.size - 1}` : "";
    const dateStr = dates.length === 1 ? formatDateShort(dates[0]) : `${dates.length} dates`;
    return `Snipe Now — ${name}${extra}, ${dateStr}`;
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
            <p className="text-xs text-stone-400 mt-0.5">Grabs a slot the moment it opens on Resy</p>
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
              <button onClick={clearAllRestaurants} disabled={isRunning} className="ml-auto text-[10px] text-stone-400 hover:text-stone-600 underline">Clear</button>
            )}
          </div>
          <div className="space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
            {resyRestaurants.map(r => {
              const isSelected = selectedIds.has(r.id);
              const dropDate = getDropDate(r);
              return (
                <button key={r.id} onClick={() => toggleRestaurant(r.id)} disabled={isRunning} className={sel(isSelected)}>
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
              <button onClick={autoFillDropDates} disabled={isRunning} className="ml-auto text-[11px] text-amber-600 hover:text-amber-800 font-medium underline">
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
              disabled={isRunning}
            />
            <button onClick={() => addDate(dateInput)} disabled={isRunning || !dateInput}
              className="px-3 py-2 bg-charcoal text-white rounded-lg text-sm font-medium hover:bg-charcoal/90 disabled:opacity-40">
              Add
            </button>
          </div>
          {dates.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {dates.map(d => (
                <span key={d} className="inline-flex items-center gap-1 bg-stone-100 text-stone-700 px-2.5 py-1 rounded-lg text-xs">
                  {formatDateShort(d)}
                  <button onClick={() => removeDate(d)} disabled={isRunning} className="text-stone-400 hover:text-stone-600">&times;</button>
                </span>
              ))}
              {dates.length > 1 && (
                <button onClick={() => setDates([])} disabled={isRunning} className="text-[10px] text-stone-400 hover:text-stone-600 underline px-1">Clear all</button>
              )}
            </div>
          )}
        </div>

        {/* Step 3: Dining times */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="w-5 h-5 rounded-full bg-charcoal text-white text-[10px] flex items-center justify-center font-bold shrink-0">3</span>
            <span className="text-sm font-semibold text-charcoal">Dining times</span>
            {!timesCustomized && dayTimeWindows && selectedTimes.size > 0 && (
              <span className="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full">from settings</span>
            )}
            <button
              onClick={() => {
                if (timesCustomized && dayTimeWindows) {
                  const auto = timesFromWindows(dates, dayTimeWindows);
                  if (auto.size > 0) setSelectedTimes(auto);
                }
                setTimesCustomized(v => !v);
              }}
              disabled={isRunning}
              className="ml-auto text-[10px] text-stone-400 hover:text-stone-600 underline"
            >
              {timesCustomized ? "Reset to settings" : "Customize"}
            </button>
          </div>
          {timesCustomized ? (
            <div className="flex flex-wrap gap-1.5">
              {TIME_OPTIONS.map(t => (
                <button key={t} onClick={() => toggleTime(t)} disabled={isRunning}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    selectedTimes.has(t) ? "bg-charcoal text-white" : "bg-stone-100 text-stone-500 hover:bg-stone-200"
                  }`}>
                  {formatTime12(t)}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {Array.from(selectedTimes).sort().map(t => (
                <span key={t} className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-stone-800 text-white">{formatTime12(t)}</span>
              ))}
              {selectedTimes.size === 0 && (
                <span className="text-xs text-stone-400">Select dates first, or customize</span>
              )}
            </div>
          )}
        </div>

        {/* Party size + Advanced toggle */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-stone-500 font-medium">Party:</span>
          {([2, 4] as const).map(size => (
            <button key={size} onClick={() => setSnipePartySize(size)} disabled={isRunning}
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
              <select value={timeRadius} onChange={(e) => setTimeRadius(Number(e.target.value))} disabled={isRunning}
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold/50">
                <option value={15}>±15 min</option>
                <option value={30}>±30 min</option>
                <option value={60}>±60 min</option>
                <option value={120}>±2 hrs</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-stone-500 mb-1">Snipe window</label>
              <select value={snipeWindow} onChange={(e) => setSnipeWindow(Number(e.target.value))} disabled={isRunning}
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold/50">
                <option value={15}>15 sec</option>
                <option value={30}>30 sec</option>
                <option value={60}>60 sec</option>
                <option value={120}>2 min</option>
              </select>
            </div>
          </div>
        )}

        {/* Action buttons */}
        {!isRunning ? (
          <div className="space-y-2">
            <button onClick={launchSnipe} disabled={!canLaunch}
              className="w-full py-3.5 bg-charcoal text-white rounded-xl text-sm font-semibold hover:bg-charcoal/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              {launchLabel}
            </button>
            {canLaunch && (
              <button onClick={() => setShowScheduler(v => !v)}
                className="w-full py-2.5 border border-stone-200 text-stone-600 rounded-xl text-sm font-medium hover:bg-stone-50 transition-colors">
                {showScheduler ? "Cancel" : `Schedule for ${formatTime12(scheduleDropTime)} ET`}
              </button>
            )}
          </div>
        ) : (
          <button onClick={cancelSnipe}
            className="w-full py-3.5 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 transition-colors">
            Cancel Snipe
          </button>
        )}

        {/* Schedule confirm */}
        {showScheduler && !isRunning && (
          <div className="bg-stone-50 border border-stone-200 rounded-xl p-3 space-y-2">
            <p className="text-xs text-stone-500">
              Auto-fires at the configured drop time — runs server-side, no need to keep the browser open.
            </p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-stone-600">Drop time (ET):</span>
              <select value={scheduleDropTime} onChange={(e) => setScheduleDropTime(e.target.value)}
                className="px-3 py-1.5 border border-stone-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold/50">
                {[...new Set([...DROP_TIME_OPTIONS, scheduleDropTime])].sort().map(t => (
                  <option key={t} value={t}>{formatTime12(t)} ET</option>
                ))}
              </select>
              <button onClick={scheduleSnipe} disabled={schedulingInProgress || !authToken}
                className="ml-auto px-4 py-1.5 bg-charcoal text-white rounded-lg text-sm font-medium hover:bg-charcoal/90 disabled:opacity-50">
                {schedulingInProgress ? "Scheduling..." : "Confirm"}
              </button>
            </div>
          </div>
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

      {/* Event Log */}
      {events.length > 0 && (
        <div className="border-t border-stone-200">
          <div ref={logRef} className="max-h-48 overflow-y-auto p-3 space-y-1 bg-stone-50 font-mono text-xs">
            {events.map((event, i) => (
              <div key={i} className={`flex items-start gap-2 ${
                event.type === "booked" ? "text-emerald-600 font-bold" :
                event.type === "error" || event.type === "book_failed" ? "text-red-500" :
                event.type === "slots_found" ? "text-blue-600" : "text-stone-500"
              }`}>
                <span className="shrink-0">{getEventIcon(event.type)}</span>
                <span>{getEventText(event)}</span>
              </div>
            ))}
          </div>
          {result === "success" && (
            <div className="px-4 py-3 bg-emerald-50 border-t border-emerald-200 text-emerald-700 text-sm font-medium text-center">
              Reservation booked!
            </div>
          )}
          {result === "failed" && !isRunning && (
            <div className="px-4 py-3 bg-red-50 border-t border-red-200 text-red-600 text-sm text-center">
              No slot found. Try adjusting times, dates, or flexibility.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
