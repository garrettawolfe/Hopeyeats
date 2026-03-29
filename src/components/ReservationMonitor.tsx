"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { restaurants } from "@/data/restaurants";
import type { AvailabilitySlot } from "@/lib/resyApi";
import type { MonitorPollResult, SerializableSlotDiff } from "@/lib/resyMonitor";

interface Props {
  partySize: number;
}

type MonitorStatus = "idle" | "polling" | "running" | "error";

interface PollHistory {
  result: MonitorPollResult;
  timestamp: string;
}

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
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

// Restaurants that can be monitored (have a Resy venue ID)
const monitorableRestaurants = restaurants.filter(
  (r) =>
    r.resyVenueId !== null &&
    r.resyUrl !== null &&
    (r.reservationMethod === "resy" || r.reservationMethod === "both"),
);

export default function ReservationMonitor({ partySize }: Props) {
  const [status, setStatus] = useState<MonitorStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(monitorableRestaurants.map((r) => r.id)),
  );
  const [pollInterval, setPollInterval] = useState(60); // seconds
  const [pollHistory, setPollHistory] = useState<PollHistory[]>([]);
  const [latestResult, setLatestResult] = useState<MonitorPollResult | null>(null);
  const [allNewSlots, setAllNewSlots] = useState<AvailabilitySlot[]>([]);
  const [isExpanded, setIsExpanded] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [lastPollTime, setLastPollTime] = useState<string | null>(null);
  const [, setTick] = useState(0); // force re-render for timeAgo

  // Tick every 10s to update "time ago" displays
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10000);
    return () => clearInterval(t);
  }, []);

  const poll = useCallback(async () => {
    setStatus("polling");
    setError(null);

    try {
      const res = await fetch("/api/resy-monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restaurantIds: Array.from(selectedIds),
          partySize,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const result: MonitorPollResult = await res.json();
      const now = new Date().toISOString();

      setLatestResult(result);
      setLastPollTime(now);
      setPollHistory((prev) => [{ result, timestamp: now }, ...prev].slice(0, 50));

      // Accumulate new slots (skip baseline)
      if (!result.isBaseline) {
        const freshSlots = result.diffs.flatMap((d) => d.newSlots);
        if (freshSlots.length > 0) {
          setAllNewSlots((prev) => [...freshSlots, ...prev].slice(0, 200));
        }
      }

      setStatus("running");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Poll failed");
      setStatus("error");
    }
  }, [selectedIds, partySize]);

  const startMonitoring = useCallback(() => {
    // Initial poll
    poll();

    // Set up interval
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(poll, pollInterval * 1000);
    setStatus("running");
  }, [poll, pollInterval]);

  const stopMonitoring = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setStatus("idle");
  }, []);

  const resetMonitor = useCallback(async () => {
    stopMonitoring();
    setAllNewSlots([]);
    setPollHistory([]);
    setLatestResult(null);
    setLastPollTime(null);
    setError(null);

    // Reset server-side state
    await fetch("/api/resy-monitor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reset: true }),
    });

    setStatus("idle");
  }, [stopMonitoring]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const toggleRestaurant = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () =>
    setSelectedIds(new Set(monitorableRestaurants.map((r) => r.id)));
  const selectNone = () => setSelectedIds(new Set());

  const statusIndicator = {
    idle: { color: "bg-stone-300", label: "Idle" },
    polling: { color: "bg-amber-400 animate-pulse", label: "Scanning..." },
    running: { color: "bg-emerald-500 animate-pulse", label: "Monitoring" },
    error: { color: "bg-red-500", label: "Error" },
  };

  const { color: statusColor, label: statusLabel } = statusIndicator[status];

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-sm">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-6 py-4 flex items-center justify-between hover:bg-stone-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full ${statusColor}`} />
          <h2 className="text-lg font-semibold text-[#1C1C1C]">
            Reservation Monitor
          </h2>
          <span className="text-xs text-stone-400 bg-stone-100 px-2 py-0.5 rounded-full">
            {statusLabel}
          </span>
          {latestResult && !latestResult.isBaseline && (
            <span className="text-xs text-stone-400">
              · Poll #{latestResult.pollCount}
              {lastPollTime && ` · ${timeAgo(lastPollTime)}`}
            </span>
          )}
        </div>
        <svg
          className={`w-5 h-5 text-stone-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isExpanded && (
        <div className="px-6 pb-6 border-t border-stone-100">
          {/* Controls */}
          <div className="py-4 flex flex-wrap items-center gap-3">
            {status === "idle" || status === "error" ? (
              <button
                onClick={startMonitoring}
                disabled={selectedIds.size === 0}
                className="px-5 py-2 bg-[#1C1C1C] text-white rounded-xl text-sm font-medium hover:bg-[#333] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Start Monitoring
              </button>
            ) : (
              <button
                onClick={stopMonitoring}
                className="px-5 py-2 bg-red-600 text-white rounded-xl text-sm font-medium hover:bg-red-700 transition-colors"
              >
                Stop
              </button>
            )}
            <button
              onClick={() => poll()}
              disabled={status === "polling" || selectedIds.size === 0}
              className="px-4 py-2 border border-stone-200 rounded-xl text-sm text-stone-600 hover:bg-stone-50 transition-colors disabled:opacity-40"
            >
              Poll Now
            </button>
            <button
              onClick={resetMonitor}
              className="px-4 py-2 border border-stone-200 rounded-xl text-sm text-stone-400 hover:text-red-600 hover:border-red-200 transition-colors"
            >
              Reset
            </button>

            <div className="flex items-center gap-2 ml-auto">
              <label className="text-xs text-stone-400">Interval:</label>
              <select
                value={pollInterval}
                onChange={(e) => setPollInterval(Number(e.target.value))}
                className="px-2 py-1.5 border border-stone-200 rounded-lg text-xs bg-white text-stone-600"
              >
                <option value={30}>30s</option>
                <option value={60}>1 min</option>
                <option value={120}>2 min</option>
                <option value={300}>5 min</option>
                <option value={600}>10 min</option>
              </select>
            </div>
          </div>

          {/* Restaurant Selection */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-stone-600">
                Monitoring {selectedIds.size} of {monitorableRestaurants.length} restaurants
              </h3>
              <div className="flex gap-2">
                <button
                  onClick={selectAll}
                  className="text-xs text-stone-400 hover:text-stone-600 underline"
                >
                  All
                </button>
                <button
                  onClick={selectNone}
                  className="text-xs text-stone-400 hover:text-stone-600 underline"
                >
                  None
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {monitorableRestaurants.map((r) => (
                <button
                  key={r.id}
                  onClick={() => toggleRestaurant(r.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    selectedIds.has(r.id)
                      ? "bg-[#1C1C1C] text-white"
                      : "bg-stone-100 text-stone-400 hover:bg-stone-200"
                  }`}
                >
                  {r.name}
                </button>
              ))}
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Summary */}
          {latestResult && (
            <div className="mb-4 bg-stone-50 rounded-xl px-4 py-3">
              <p className="text-sm text-stone-600">{latestResult.summary}</p>
            </div>
          )}

          {/* New Slots Feed */}
          {allNewSlots.length > 0 && (
            <div className="mb-4">
              <h3 className="text-sm font-medium text-emerald-700 mb-2 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                New Slots Detected ({allNewSlots.length})
              </h3>
              <div className="max-h-64 overflow-y-auto space-y-1">
                {allNewSlots.map((slot, i) => (
                  <a
                    key={`${slot.id}-${i}`}
                    href={slot.resyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between px-3 py-2 bg-emerald-50 border border-emerald-100 rounded-lg hover:bg-emerald-100 transition-colors group"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-[#1C1C1C]">
                        {slot.venueName}
                      </span>
                      <span className="text-xs text-stone-500">
                        {formatDate(slot.date)} at {formatTime12(slot.time)}
                      </span>
                      <span className="text-xs text-stone-400">
                        {slot.tableType}
                      </span>
                      <span className="text-xs text-stone-400">
                        ({slot.minParty}–{slot.maxParty} guests)
                      </span>
                    </div>
                    <span className="text-xs text-emerald-600 opacity-0 group-hover:opacity-100 transition-opacity">
                      Book on Resy →
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Per-Restaurant Status */}
          {latestResult && latestResult.diffs.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-stone-600 mb-2">
                Availability by Restaurant
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {latestResult.diffs.map((diff: SerializableSlotDiff) => (
                  <RestaurantSlotSummary key={diff.restaurant.id} diff={diff} />
                ))}
              </div>
            </div>
          )}

          {/* Poll History */}
          {pollHistory.length > 1 && (
            <details className="mt-4">
              <summary className="text-xs text-stone-400 cursor-pointer hover:text-stone-600">
                Poll History ({pollHistory.length} polls)
              </summary>
              <div className="mt-2 max-h-40 overflow-y-auto space-y-1 text-xs text-stone-500">
                {pollHistory.map((entry, i) => (
                  <div
                    key={i}
                    className="flex justify-between px-2 py-1 bg-stone-50 rounded"
                  >
                    <span>{entry.result.summary}</span>
                    <span className="text-stone-400 shrink-0 ml-2">
                      {timeAgo(entry.timestamp)}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function RestaurantSlotSummary({ diff }: { diff: SerializableSlotDiff }) {
  const hasNew = diff.newSlots.length > 0;
  const hasDropped = diff.droppedSlots.length > 0;

  return (
    <div
      className={`px-3 py-2 rounded-lg border text-sm ${
        hasNew
          ? "bg-emerald-50 border-emerald-200"
          : diff.totalAvailable > 0
            ? "bg-white border-stone-200"
            : "bg-stone-50 border-stone-100"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-[#1C1C1C]">
          {diff.restaurant.name}
        </span>
        <span
          className={`text-xs ${
            diff.totalAvailable > 0 ? "text-emerald-600" : "text-stone-400"
          }`}
        >
          {diff.totalAvailable} slot{diff.totalAvailable !== 1 ? "s" : ""}
        </span>
      </div>
      {(hasNew || hasDropped) && (
        <div className="flex gap-3 mt-1 text-xs">
          {hasNew && (
            <span className="text-emerald-600">
              +{diff.newSlots.length} new
            </span>
          )}
          {hasDropped && (
            <span className="text-red-500">
              -{diff.droppedSlots.length} taken
            </span>
          )}
        </div>
      )}
    </div>
  );
}
