"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { restaurants } from "@/data/restaurants";
import type { AvailabilitySlot } from "@/lib/resyApi";
import type { MonitorPollResult, SerializableSlotDiff } from "@/lib/resyMonitor";

interface Props {
  partySize: number;
}

type MonitorStatus = "idle" | "polling" | "running" | "error" | "rate-limited";

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

// All restaurants that have Resy URLs (venue IDs can be resolved at runtime)
const resyRestaurants = restaurants.filter(
  (r) =>
    r.resyUrl !== null &&
    (r.reservationMethod === "resy" || r.reservationMethod === "both"),
);

export default function ReservationMonitor({ partySize }: Props) {
  const [status, setStatus] = useState<MonitorStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(resyRestaurants.map((r) => r.id)),
  );
  const [pollInterval, setPollInterval] = useState(60);
  const [pollHistory, setPollHistory] = useState<PollHistory[]>([]);
  const [latestResult, setLatestResult] = useState<MonitorPollResult | null>(
    null,
  );
  const [allNewSlots, setAllNewSlots] = useState<AvailabilitySlot[]>([]);
  const [isExpanded, setIsExpanded] = useState(true);
  const [resolveIds, setResolveIds] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [lastPollTime, setLastPollTime] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [showRestaurants, setShowRestaurants] = useState(false);
  const [notifySound, setNotifySound] = useState(true);

  // Tick every 10s to update "time ago" displays
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10000);
    return () => clearInterval(t);
  }, []);

  // Play notification sound when new slots are found
  const playNotification = useCallback(() => {
    if (!notifySound) return;
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = "sine";
      gain.gain.value = 0.1;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.stop(ctx.currentTime + 0.3);
    } catch {
      // Audio not available
    }
  }, [notifySound]);

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
          resolveIds,
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
      setPollHistory((prev) =>
        [{ result, timestamp: now }, ...prev].slice(0, 50),
      );

      // Check for rate limiting
      if (result.rateLimitStats?.isBackedOff) {
        setStatus("rate-limited");
        return;
      }

      // Accumulate new slots (skip baseline)
      if (!result.isBaseline) {
        const freshSlots = result.diffs.flatMap((d) => d.newSlots);
        if (freshSlots.length > 0) {
          setAllNewSlots((prev) =>
            [...freshSlots, ...prev].slice(0, 500),
          );
          playNotification();
          // Browser notification
          if (Notification.permission === "granted") {
            new Notification("New Resy Slots!", {
              body: `${freshSlots.length} new reservation${freshSlots.length !== 1 ? "s" : ""} available`,
              tag: "resy-monitor",
            });
          }
        }
      }

      setStatus("running");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Poll failed");
      setStatus("error");
    }
  }, [selectedIds, partySize, resolveIds, playNotification]);

  const startMonitoring = useCallback(() => {
    // Request notification permission
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }

    poll();

    if (intervalRef.current) clearInterval(intervalRef.current);
    // Add jitter to interval: ±15%
    const jitteredMs = pollInterval * 1000 * (0.85 + Math.random() * 0.3);
    intervalRef.current = setInterval(poll, jitteredMs);
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

    await fetch("/api/resy-monitor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reset: true }),
    });

    setStatus("idle");
  }, [stopMonitoring]);

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
    setSelectedIds(new Set(resyRestaurants.map((r) => r.id)));
  const selectNone = () => setSelectedIds(new Set());

  const statusIndicator: Record<
    MonitorStatus,
    { color: string; label: string }
  > = {
    idle: { color: "bg-stone-300", label: "Idle" },
    polling: { color: "bg-amber-400 animate-pulse", label: "Scanning..." },
    running: { color: "bg-emerald-500 animate-pulse", label: "Monitoring" },
    error: { color: "bg-red-500", label: "Error" },
    "rate-limited": {
      color: "bg-orange-500 animate-pulse",
      label: "Rate Limited",
    },
  };

  const { color: statusColor, label: statusLabel } = statusIndicator[status];

  const rateLimitInfo = latestResult?.rateLimitStats;

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
          {allNewSlots.length > 0 && (
            <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
              {allNewSlots.length} new
            </span>
          )}
          {latestResult && (
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

            <div className="flex items-center gap-3 ml-auto">
              <label className="flex items-center gap-1.5 text-xs text-stone-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={notifySound}
                  onChange={(e) => setNotifySound(e.target.checked)}
                  className="rounded border-stone-300 text-[#1C1C1C] focus:ring-[#C9A84C]"
                />
                Sound
              </label>
              <label className="flex items-center gap-1.5 text-xs text-stone-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={resolveIds}
                  onChange={(e) => setResolveIds(e.target.checked)}
                  className="rounded border-stone-300 text-[#1C1C1C] focus:ring-[#C9A84C]"
                />
                Auto-resolve IDs
              </label>
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-stone-400">Interval:</label>
                <select
                  value={pollInterval}
                  onChange={(e) => setPollInterval(Number(e.target.value))}
                  className="px-2 py-1.5 border border-stone-200 rounded-lg text-xs bg-white text-stone-600"
                >
                  <option value={30}>30s</option>
                  <option value={45}>45s</option>
                  <option value={60}>1 min</option>
                  <option value={90}>90s</option>
                  <option value={120}>2 min</option>
                  <option value={300}>5 min</option>
                </select>
              </div>
            </div>
          </div>

          {/* Restaurant Selection (collapsible) */}
          <div className="mb-4">
            <button
              onClick={() => setShowRestaurants(!showRestaurants)}
              className="flex items-center gap-2 mb-2 text-sm font-medium text-stone-600 hover:text-stone-800"
            >
              <svg
                className={`w-3.5 h-3.5 transition-transform ${showRestaurants ? "rotate-90" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
              Monitoring {selectedIds.size} of {resyRestaurants.length}{" "}
              restaurants
            </button>
            {showRestaurants && (
              <>
                <div className="flex gap-2 mb-2">
                  <button
                    onClick={selectAll}
                    className="text-xs text-stone-400 hover:text-stone-600 underline"
                  >
                    Select All
                  </button>
                  <button
                    onClick={selectNone}
                    className="text-xs text-stone-400 hover:text-stone-600 underline"
                  >
                    Clear All
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto">
                  {resyRestaurants.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => toggleRestaurant(r.id)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                        selectedIds.has(r.id)
                          ? "bg-[#1C1C1C] text-white"
                          : "bg-stone-100 text-stone-400 hover:bg-stone-200"
                      }`}
                    >
                      {r.name}
                      {r.resyVenueId ? "" : " *"}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-stone-300 mt-1">
                  * = venue ID will be resolved on first poll
                </p>
              </>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Rate Limit Warning */}
          {rateLimitInfo?.isBackedOff && (
            <div className="mb-4 bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 text-sm text-orange-700">
              Rate limited — backing off for{" "}
              {Math.round(rateLimitInfo.backoffRemaining / 1000)}s.{" "}
              Total 429s: {rateLimitInfo.total429s}
            </div>
          )}

          {/* Summary */}
          {latestResult && (
            <div className="mb-4 bg-stone-50 rounded-xl px-4 py-3 flex items-center justify-between">
              <p className="text-sm text-stone-600">{latestResult.summary}</p>
              {rateLimitInfo && (
                <span className="text-[10px] text-stone-400">
                  {rateLimitInfo.totalRequests} reqs /{" "}
                  {rateLimitInfo.total429s} throttled
                </span>
              )}
            </div>
          )}

          {/* New Slots Feed */}
          {allNewSlots.length > 0 && (
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-emerald-700 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  New Slots ({allNewSlots.length})
                </h3>
                <button
                  onClick={() => setAllNewSlots([])}
                  className="text-[10px] text-stone-400 hover:text-stone-600 underline"
                >
                  Clear
                </button>
              </div>
              <div className="max-h-72 overflow-y-auto space-y-1">
                {allNewSlots.map((slot, i) => (
                  <a
                    key={`${slot.id}-${i}`}
                    href={slot.resyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between px-3 py-2 bg-emerald-50 border border-emerald-100 rounded-lg hover:bg-emerald-100 transition-colors group"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-[#1C1C1C]">
                        {slot.venueName}
                      </span>
                      <span className="text-xs text-stone-500">
                        {formatDate(slot.date)} at {formatTime12(slot.time)}
                      </span>
                      <span className="text-[10px] text-stone-400 bg-stone-100 px-1.5 py-0.5 rounded">
                        {slot.tableType}
                      </span>
                      <span className="text-[10px] text-stone-400">
                        {slot.minParty}–{slot.maxParty}p
                      </span>
                    </div>
                    <span className="text-xs text-emerald-600 font-medium opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2">
                      Book →
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
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
                {[...latestResult.diffs]
                  .sort((a, b) => b.totalAvailable - a.totalAvailable)
                  .map((diff: SerializableSlotDiff) => (
                    <RestaurantSlotSummary
                      key={diff.restaurant.id}
                      diff={diff}
                    />
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
        <span className="font-medium text-[#1C1C1C] text-xs">
          {diff.restaurant.name}
        </span>
        <span
          className={`text-[10px] font-medium ${
            diff.totalAvailable > 0 ? "text-emerald-600" : "text-stone-400"
          }`}
        >
          {diff.totalAvailable}
        </span>
      </div>
      {(hasNew || hasDropped) && (
        <div className="flex gap-2 mt-0.5 text-[10px]">
          {hasNew && (
            <span className="text-emerald-600 font-medium">
              +{diff.newSlots.length} new
            </span>
          )}
          {hasDropped && (
            <span className="text-red-400">-{diff.droppedSlots.length}</span>
          )}
        </div>
      )}
    </div>
  );
}
