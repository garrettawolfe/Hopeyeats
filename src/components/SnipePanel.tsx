"use client";

import { useState, useRef } from "react";
import type { Restaurant } from "@/data/restaurants";

interface SnipeEvent {
  type: string;
  [key: string]: unknown;
}

interface SnipeConfig {
  restaurantIds: string[];
  date: string;
  partySize: number;
  preferredTimes: string[];
  timeRadius: number;
  snipeWindowSeconds: number;
  pollIntervalMs: number;
}

interface Props {
  restaurants: Restaurant[];
  isAuthenticated: boolean;
  authToken?: string;
  partySize: number;
  onBooked?: (event: SnipeEvent) => void;
}

const TIME_OPTIONS = [
  "17:00", "17:30", "18:00", "18:30", "19:00", "19:30",
  "20:00", "20:30", "21:00", "21:30", "22:00",
];

function formatTime12(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export default function SnipePanel({ restaurants, isAuthenticated, authToken, partySize, onBooked }: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [date, setDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split("T")[0];
  });
  const [selectedTimes, setSelectedTimes] = useState<Set<string>>(new Set(["19:00", "19:30", "20:00"]));
  const [timeRadius, setTimeRadius] = useState(30);
  const [snipeWindow, setSnipeWindow] = useState(30);
  const [isRunning, setIsRunning] = useState(false);
  const [events, setEvents] = useState<SnipeEvent[]>([]);
  const [result, setResult] = useState<"success" | "failed" | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const toggleRestaurant = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleTime = (t: string) => {
    setSelectedTimes(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const selectAllRestaurants = () => {
    setSelectedIds(new Set(restaurants.filter(r => r.resyVenueId).map(r => r.id)));
  };

  const clearAllRestaurants = () => {
    setSelectedIds(new Set());
  };

  const launchSnipe = async () => {
    if (selectedIds.size === 0 || selectedTimes.size === 0 || !date) return;

    setIsRunning(true);
    setEvents([]);
    setResult(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const config: SnipeConfig = {
        restaurantIds: Array.from(selectedIds),
        date,
        partySize,
        preferredTimes: Array.from(selectedTimes).sort(),
        timeRadius,
        snipeWindowSeconds: snipeWindow,
        pollIntervalMs: 300,
      };

      const res = await fetch("/api/resy-snipe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, authToken }),
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

            // Auto-scroll log
            setTimeout(() => {
              logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
            }, 50);
          } catch {
            // skip malformed
          }
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
      case "started": return "🚀";
      case "attempt": return "🔍";
      case "slots_found": return "✨";
      case "booked": return "✅";
      case "book_failed": return "❌";
      case "error": return "⚠️";
      case "done": return "🏁";
      case "cancelled": return "🛑";
      default: return "•";
    }
  };

  const getEventText = (event: SnipeEvent): string => {
    switch (event.type) {
      case "started":
        return `Targeting ${(event.targets as string[])?.join(", ")} on ${event.date}`;
      case "attempt":
        return `Attempt #${event.attempt} (${Math.round(Number(event.elapsed) / 1000)}s)`;
      case "slots_found":
        return `${event.restaurant}: ${event.count} slots found, best: ${formatTime12(String(event.bestTime))}`;
      case "booked":
        return `BOOKED! ${event.restaurant} at ${formatTime12(String(event.time))} on ${event.date}`;
      case "book_failed":
        return `${event.restaurant} ${formatTime12(String(event.time))}: ${event.error}`;
      case "error":
        return `Error: ${event.error}`;
      case "done":
        return `Finished — ${event.attempts} attempts in ${Math.round(Number(event.elapsed) / 1000)}s`;
      case "cancelled":
        return "Snipe cancelled";
      default:
        return JSON.stringify(event);
    }
  };

  const resyRestaurants = restaurants.filter(r => r.resyVenueId);

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
      {/* Config Section */}
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-lg text-charcoal">Snipe Mode</h2>
          {!isAuthenticated && (
            <span className="text-xs text-red-500 bg-red-50 px-2 py-1 rounded-full">Auth required</span>
          )}
        </div>

        {/* Date + Time Radius + Window */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-stone-500 mb-1">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
              disabled={isRunning}
            />
          </div>
          <div>
            <label className="block text-xs text-stone-500 mb-1">Flexibility</label>
            <select
              value={timeRadius}
              onChange={(e) => setTimeRadius(Number(e.target.value))}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
              disabled={isRunning}
            >
              <option value={15}>±15 min</option>
              <option value={30}>±30 min</option>
              <option value={60}>±60 min</option>
              <option value={120}>±2 hrs</option>
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
            <div className="px-3 py-2 border border-stone-200 rounded-lg text-sm text-stone-600 bg-stone-50">
              {partySize}
            </div>
          </div>
        </div>

        {/* Preferred Times */}
        <div>
          <label className="block text-xs text-stone-500 mb-1.5">Preferred Times (in priority order)</label>
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

        {/* Restaurant Selection */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs text-stone-500">Target Restaurants ({selectedIds.size})</label>
            <div className="flex gap-2">
              <button onClick={selectAllRestaurants} disabled={isRunning} className="text-[10px] text-stone-400 hover:text-stone-600 underline">All</button>
              <button onClick={clearAllRestaurants} disabled={isRunning} className="text-[10px] text-stone-400 hover:text-stone-600 underline">Clear</button>
            </div>
          </div>
          <div className="max-h-40 overflow-y-auto border border-stone-200 rounded-lg p-2 space-y-0.5">
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
                <span className="text-[10px] text-stone-400 ml-auto shrink-0">{r.neighborhood}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Launch Button */}
        <div className="flex gap-2">
          {!isRunning ? (
            <button
              onClick={launchSnipe}
              disabled={!isAuthenticated || selectedIds.size === 0 || selectedTimes.size === 0}
              className="flex-1 py-3 bg-charcoal text-white rounded-xl text-sm font-semibold hover:bg-charcoal/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Launch Snipe ({selectedIds.size} restaurant{selectedIds.size !== 1 ? "s" : ""})
            </button>
          ) : (
            <button
              onClick={cancelSnipe}
              className="flex-1 py-3 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 transition-colors"
            >
              Cancel Snipe
            </button>
          )}
        </div>
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

          {/* Result Banner */}
          {result === "success" && (
            <div className="px-4 py-3 bg-emerald-50 border-t border-emerald-200 text-emerald-700 text-sm font-medium text-center">
              Reservation booked successfully!
            </div>
          )}
          {result === "failed" && !isRunning && (
            <div className="px-4 py-3 bg-red-50 border-t border-red-200 text-red-600 text-sm text-center">
              No reservation booked. Try adjusting times or restaurants.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
