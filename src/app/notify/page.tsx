"use client";

import { useState, useEffect, useCallback } from "react";
import { restaurants } from "@/data/restaurants";
import type { NotifyRecord } from "@/lib/scheduledSnipes";
import AppNav from "@/components/AppNav";

const resyRestaurants = restaurants.filter(
  (r) => r.resyVenueId && (r.reservationMethod === "resy" || r.reservationMethod === "both"),
);

function getWeekendDates(weekOffset: 0 | 1): string[] {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  const daysToFri = ((5 - day + 7) % 7) + weekOffset * 7;
  const fri = new Date(now);
  fri.setDate(now.getDate() + daysToFri);
  const sat = new Date(fri);
  sat.setDate(fri.getDate() + 1);
  const toISO = (d: Date) => d.toISOString().split("T")[0];
  return [toISO(fri), toISO(sat)];
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

type NotifyResult = { restaurantId: string; restaurantName: string; date: string; success: boolean; error?: string };

export default function NotifyPage() {
  const [authToken, setAuthToken] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [customDate, setCustomDate] = useState("");
  const [partySize, setPartySize] = useState(2);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<NotifyResult[] | null>(null);
  const [records, setRecords] = useState<NotifyRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const token = localStorage.getItem("resyAuthToken") ?? "";
    setAuthToken(token);
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

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  const toggleRestaurant = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleDate = (date: string) => {
    setSelectedDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  const applyWeekend = (offset: 0 | 1) => {
    setSelectedDates(new Set(getWeekendDates(offset)));
  };

  const addCustomDate = () => {
    if (!customDate) return;
    setSelectedDates((prev) => new Set([...prev, customDate]));
    setCustomDate("");
  };

  const filteredRestaurants = resyRestaurants.filter(
    (r) =>
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.neighborhood.toLowerCase().includes(search.toLowerCase()),
  );

  const handleSubmit = async () => {
    if (!authToken) {
      alert("No auth token — log in on the main page first.");
      return;
    }
    if (selectedIds.size === 0 || selectedDates.size === 0) {
      alert("Select at least one restaurant and one date.");
      return;
    }

    setLoading(true);
    setResults(null);
    try {
      const res = await fetch("/api/resy-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restaurantIds: Array.from(selectedIds),
          dates: Array.from(selectedDates).sort(),
          partySize,
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
  const totalRequests = selectedIds.size * selectedDates.size;

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
      <p className="text-gray-600 text-sm mb-6">
        Mass-place Resy &quot;Notify Me&quot; requests for multiple restaurants and dates. Resy will
        email you when a table opens up.
      </p>

      {/* Date Selection */}
      <section className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <h2 className="font-semibold text-gray-900 mb-3">Dates</h2>
        <div className="flex gap-2 mb-3 flex-wrap">
          <button
            onClick={() => applyWeekend(0)}
            className="px-3 py-1.5 text-sm bg-orange-100 text-orange-800 rounded-lg hover:bg-orange-200 transition-colors"
          >
            This Weekend
          </button>
          <button
            onClick={() => applyWeekend(1)}
            className="px-3 py-1.5 text-sm bg-orange-100 text-orange-800 rounded-lg hover:bg-orange-200 transition-colors"
          >
            Next Weekend
          </button>
          <button
            onClick={() => setSelectedDates(new Set())}
            className="px-3 py-1.5 text-sm bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition-colors"
          >
            Clear
          </button>
        </div>

        {selectedDates.size > 0 && (
          <div className="flex gap-2 flex-wrap mb-3">
            {Array.from(selectedDates)
              .sort()
              .map((date) => (
                <span
                  key={date}
                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-orange-50 border border-orange-200 rounded-lg text-sm text-orange-900"
                >
                  {formatDate(date)}
                  <button
                    onClick={() => toggleDate(date)}
                    className="text-orange-400 hover:text-orange-700 ml-0.5 leading-none"
                  >
                    ×
                  </button>
                </span>
              ))}
          </div>
        )}

        <div className="flex gap-2">
          <input
            type="date"
            value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
            className="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
          />
          <button
            onClick={addCustomDate}
            disabled={!customDate}
            className="flex-shrink-0 px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50 transition-colors"
          >
            Add Date
          </button>
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
              onClick={() => toggleRestaurant(r.id)}
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
        disabled={loading || selectedIds.size === 0 || selectedDates.size === 0}
        className="w-full py-3 bg-orange-500 text-white font-semibold rounded-xl hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors mb-4"
      >
        {loading
          ? `Placing ${totalRequests} notifies...`
          : `Place Notifies — ${selectedIds.size} restaurant${selectedIds.size !== 1 ? "s" : ""} × ${selectedDates.size} date${selectedDates.size !== 1 ? "s" : ""}`}
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
                <span className="font-medium truncate max-w-[160px]">{r.restaurantName}</span>
                <span className="text-xs text-current opacity-70">{formatDate(r.date)}</span>
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
