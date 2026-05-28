"use client";

import { useState, useEffect, useCallback } from "react";
import { restaurants } from "@/data/restaurants";
import type { NotifyRecord } from "@/lib/scheduledSnipes";
import AppNav from "@/components/AppNav";
import { loadSettings, getActiveProfile } from "@/components/SettingsDrawer";
import type { DayTimeWindow } from "@/components/SettingsDrawer";

const resyRestaurants = restaurants.filter(
  (r) => r.resyVenueId && (r.reservationMethod === "resy" || r.reservationMethod === "both"),
);

const TIME_SLOTS = ["17:30", "18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00", "21:30"];
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_FULL = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function getUpcomingDays(count: number): { iso: string; dow: number }[] {
  const days: { iso: string; dow: number }[] = [];
  const now = new Date();
  for (let i = 1; i <= count; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const iso = d.toISOString().split("T")[0];
    days.push({ iso, dow: d.getDay() });
  }
  return days;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtDay(iso: string) {
  const [, m, d] = iso.split("-");
  return { day: parseInt(d, 10), month: parseInt(m, 10) };
}

type NotifyResult = { restaurantId: string; restaurantName: string; date: string; time?: string; success: boolean; error?: string };

export default function NotifyPage() {
  const [authToken, setAuthToken] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [selectedTimes, setSelectedTimes] = useState<Set<string>>(new Set(["19:00", "19:30"]));
  const [useTimeWindows, setUseTimeWindows] = useState(false);
  const [dayTimeWindows, setDayTimeWindows] = useState<Record<string, DayTimeWindow>>({});
  const [partySize, setPartySize] = useState(2);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<NotifyResult[] | null>(null);
  const [records, setRecords] = useState<NotifyRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [search, setSearch] = useState("");

  const upcomingDays = getUpcomingDays(21);

  useEffect(() => {
    const profile = getActiveProfile() ?? undefined;
    const s = loadSettings(profile);
    setAuthToken(s.resyAuthToken ?? "");
    setPartySize(s.partySize ?? 2);
    if (s.dayTimeWindows) setDayTimeWindows(s.dayTimeWindows);
  }, []);

  const fetchRecords = useCallback(async () => {
    setLoadingRecords(true);
    try {
      const res = await fetch("/api/resy-notify");
      const data = await res.json();
      setRecords(data.records ?? []);
    } catch {
      // ignore
    } finally {
      setLoadingRecords(false);
    }
  }, []);

  useEffect(() => { fetchRecords(); }, [fetchRecords]);

  const toggleDate = (iso: string) => {
    setSelectedDates((prev) => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso); else next.add(iso);
      return next;
    });
  };

  const toggleTime = (t: string) => {
    setSelectedTimes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  };

  const applyWeekend = (offset: 0 | 1) => {
    const now = new Date();
    const day = now.getDay();
    const daysToFri = ((5 - day + 7) % 7) + offset * 7;
    const fri = new Date(now); fri.setDate(now.getDate() + daysToFri);
    const sat = new Date(fri); sat.setDate(fri.getDate() + 1);
    const sun = new Date(fri); sun.setDate(fri.getDate() + 2);
    setSelectedDates(new Set([fri, sat, sun].map((d) => d.toISOString().split("T")[0])));
  };

  // When "use my windows" is on, compute effective times for a given date
  function timesForDate(iso: string): string[] {
    if (!useTimeWindows) return Array.from(selectedTimes);
    const dow = DOW_FULL[new Date(iso + "T12:00:00").getDay()];
    const w = dayTimeWindows[dow];
    if (!w) return Array.from(selectedTimes);
    // Return all TIME_SLOTS within [start, end]
    return TIME_SLOTS.filter((t) => t >= w.start && t <= w.end);
  }

  const filteredRestaurants = resyRestaurants.filter(
    (r) =>
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.neighborhood.toLowerCase().includes(search.toLowerCase()),
  );

  const totalRequests = selectedIds.size * Array.from(selectedDates).reduce((sum, d) => sum + timesForDate(d).length, 0);

  const handleSubmit = async () => {
    if (!authToken) {
      alert("No auth token — open Settings in the nav to connect your Resy account.");
      return;
    }
    if (selectedIds.size === 0 || selectedDates.size === 0 || selectedTimes.size === 0) {
      alert("Select at least one restaurant, one date, and one time.");
      return;
    }

    const sortedDates = Array.from(selectedDates).sort();

    setLoading(true);
    setResults(null);
    try {
      const res = await fetch("/api/resy-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restaurantIds: Array.from(selectedIds),
          dates: sortedDates,
          partySize,
          dateTimes: Object.fromEntries(sortedDates.map((d) => [d, timesForDate(d)])),
          authToken,
        }),
      });
      const data = await res.json();
      setResults(data.results ?? []);
      await fetchRecords();
    } catch (err) {
      alert("Error placing notifies: " + String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch("/api/resy-notify", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setRecords((prev) => prev.filter((r) => r.id !== id));
    } catch {
      // ignore
    }
  };

  const placed = results?.filter((r) => r.success).length ?? 0;
  const failed = results?.filter((r) => !r.success).length ?? 0;

  return (
    <div className="min-h-screen bg-[#FAF7F2]">
      <header className="sticky top-0 z-30 bg-charcoal text-white">
        <div className="max-w-4xl mx-auto px-3 sm:px-6 py-3 sm:py-4">
          <h1 className="font-serif text-xl sm:text-2xl tracking-tight">WolfePack Eats</h1>
          <p className="text-stone-400 text-[10px] sm:text-xs mt-0.5">Notify Mode</p>
        </div>
        <AppNav />
      </header>

      <main className="max-w-4xl mx-auto px-3 sm:px-6 py-4 sm:py-6">
        <p className="text-gray-600 text-sm mb-4">
          Mass-place Resy &quot;Notify Me&quot; requests. Resy will email you when a table opens.
        </p>

        {/* Date Selection */}
        <section className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-gray-900">
              Dates{" "}
              {selectedDates.size > 0 && (
                <span className="text-orange-500 font-normal text-sm">({selectedDates.size} selected)</span>
              )}
            </h2>
            <div className="flex gap-2">
              <button
                onClick={() => applyWeekend(0)}
                className="px-2.5 py-1 text-xs bg-orange-100 text-orange-800 rounded-lg hover:bg-orange-200 transition-colors"
              >
                This Weekend
              </button>
              <button
                onClick={() => applyWeekend(1)}
                className="px-2.5 py-1 text-xs bg-orange-100 text-orange-800 rounded-lg hover:bg-orange-200 transition-colors"
              >
                Next Weekend
              </button>
              {selectedDates.size > 0 && (
                <button
                  onClick={() => setSelectedDates(new Set())}
                  className="px-2.5 py-1 text-xs bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Day grid — 3 weeks */}
          <div className="overflow-x-auto -mx-1 px-1 pb-1">
            <div className="flex gap-1.5 min-w-max">
              {upcomingDays.map(({ iso, dow }) => {
                const { day, month } = fmtDay(iso);
                const active = selectedDates.has(iso);
                const isWeekend = dow === 5 || dow === 6 || dow === 0;
                return (
                  <button
                    key={iso}
                    onClick={() => toggleDate(iso)}
                    className={`flex flex-col items-center w-12 py-2 rounded-xl text-xs font-medium transition-all border ${
                      active
                        ? "bg-orange-500 text-white border-orange-500 shadow-sm scale-105"
                        : isWeekend
                          ? "bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100"
                          : "bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100"
                    }`}
                  >
                    <span className="text-[10px] opacity-75">{DOW_SHORT[dow]}</span>
                    <span className="text-base font-bold leading-tight">{day}</span>
                    <span className="text-[9px] opacity-60">{month}/{String(day).padStart(2,"0")}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* Party Size */}
        <section className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
          <h2 className="font-semibold text-gray-900 mb-3">Party Size</h2>
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5, 6].map((size) => (
              <button
                key={size}
                onClick={() => setPartySize(size)}
                className={`w-10 h-10 rounded-lg text-sm font-medium transition-colors ${
                  partySize === size
                    ? "bg-orange-500 text-white shadow-sm"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                {size}
              </button>
            ))}
          </div>
        </section>

        {/* Time Windows */}
        <section className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-gray-900">
              Time Slots{" "}
              {selectedTimes.size > 0 && !useTimeWindows && (
                <span className="text-orange-500 font-normal text-sm">({selectedTimes.size} selected)</span>
              )}
            </h2>
            {Object.keys(dayTimeWindows).length > 0 && (
              <button
                onClick={() => setUseTimeWindows((v) => !v)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                  useTimeWindows
                    ? "bg-orange-500 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {useTimeWindows ? "✓ My windows" : "Use my windows"}
              </button>
            )}
          </div>

          {useTimeWindows ? (
            <div className="space-y-1.5">
              <p className="text-xs text-gray-400 mb-2">Times are drawn from your settings windows per day of week.</p>
              {Object.entries(dayTimeWindows).map(([day, w]) => (
                <div key={day} className="flex items-center gap-2 text-sm">
                  <span className="capitalize text-gray-500 w-24">{day}</span>
                  <span className="text-orange-600 font-medium">{w.start}</span>
                  <span className="text-gray-400">–</span>
                  <span className="text-orange-600 font-medium">{w.end}</span>
                  <span className="text-gray-400 text-xs">
                    ({TIME_SLOTS.filter((t) => t >= w.start && t <= w.end).length} slots)
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-400 mb-3">Select one or more — a notify is placed for each time slot.</p>
              <div className="flex gap-2 flex-wrap">
                {TIME_SLOTS.map((t) => (
                  <button
                    key={t}
                    onClick={() => toggleTime(t)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all border ${
                      selectedTimes.has(t)
                        ? "bg-orange-500 text-white border-orange-500 shadow-sm"
                        : "bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>

        {/* Restaurant Selection */}
        <section className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="font-semibold text-gray-900 min-w-0">
              Restaurants{" "}
              <span className="text-gray-400 font-normal text-sm">({selectedIds.size} selected)</span>
            </h2>
            <div className="flex gap-2 flex-shrink-0">
              <button
                onClick={() => setSelectedIds(new Set(resyRestaurants.map((r) => r.id)))}
                className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors"
              >
                All
              </button>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors"
              >
                None
              </button>
            </div>
          </div>

          <input
            type="text"
            placeholder="Search restaurants..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-orange-300"
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-72 overflow-y-auto pr-1">
            {filteredRestaurants.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(r.id)) next.delete(r.id); else next.add(r.id);
                    return next;
                  });
                }}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-sm transition-colors ${
                  selectedIds.has(r.id)
                    ? "bg-orange-50 border border-orange-300 text-orange-900"
                    : "bg-gray-50 border border-gray-200 text-gray-700 hover:bg-gray-100"
                }`}
              >
                <span
                  className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center text-[10px] font-bold ${
                    selectedIds.has(r.id)
                      ? "bg-orange-500 border-orange-500 text-white"
                      : "border-gray-300 bg-white"
                  }`}
                >
                  {selectedIds.has(r.id) && "✓"}
                </span>
                <div className="min-w-0">
                  <div className="font-medium truncate">{r.name}</div>
                  <div className="text-xs text-gray-500">{r.neighborhood}</div>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={loading || selectedIds.size === 0 || selectedDates.size === 0 || selectedTimes.size === 0}
          className="w-full py-3 bg-orange-500 text-white font-semibold rounded-xl hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors mb-4"
        >
          {loading
            ? `Placing ${totalRequests} notifies...`
            : `Place Notifies — ${selectedIds.size} restaurant${selectedIds.size !== 1 ? "s" : ""} × ${selectedDates.size} date${selectedDates.size !== 1 ? "s" : ""} × ${useTimeWindows ? "windows" : `${selectedTimes.size} time${selectedTimes.size !== 1 ? "s" : ""}`}`}
        </button>

        {/* Results */}
        {results && (
          <section className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
            <h2 className="font-semibold text-gray-900 mb-3">
              Results —{" "}
              <span className="text-green-600">{placed} placed</span>
              {failed > 0 && <span className="text-red-500">, {failed} failed</span>}
            </h2>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {results.map((r, i) => (
                <div
                  key={i}
                  className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${
                    r.success ? "bg-green-50 text-green-900" : "bg-red-50 text-red-900"
                  }`}
                >
                  <span className="font-medium truncate max-w-[140px]">{r.restaurantName}</span>
                  <span className="text-xs opacity-70">{formatDate(r.date)}</span>
                  {r.time && <span className="text-xs opacity-70">{r.time}</span>}
                  <span className="text-xs">
                    {r.success ? "✓ placed" : `✗ ${r.error?.slice(0, 30) ?? "failed"}`}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Pending Notifies */}
        <section className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-gray-900">
              Pending Notifies{" "}
              <span className="text-gray-400 font-normal text-sm">({records.length})</span>
            </h2>
            <button
              onClick={fetchRecords}
              disabled={loadingRecords}
              className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
            >
              {loadingRecords ? "Loading..." : "Refresh"}
            </button>
          </div>

          {records.length === 0 ? (
            <p className="text-gray-400 text-sm">No notifies placed yet.</p>
          ) : (
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {records.map((rec) => (
                <div
                  key={rec.id}
                  className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${
                    rec.status === "placed" ? "bg-gray-50" : "bg-red-50"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-gray-800 truncate">{rec.restaurantName}</span>
                    <span className="text-gray-500 text-xs flex-shrink-0">{formatDate(rec.date)}</span>
                    <span className="text-gray-400 text-xs flex-shrink-0">· {rec.partySize}p</span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span
                      className={`text-xs ${rec.status === "placed" ? "text-green-600" : "text-red-500"}`}
                    >
                      {rec.status}
                    </span>
                    <button
                      onClick={() => handleDelete(rec.id)}
                      className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
