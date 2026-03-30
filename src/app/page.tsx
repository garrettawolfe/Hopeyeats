"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { restaurants } from "@/data/restaurants";
import type { AvailabilitySlot } from "@/lib/resyApi";
import type { MonitorPollResult } from "@/lib/resyMonitor";
import type { SerializableSlotDiff } from "@/lib/resyMonitor";
import type { NotificationConfig } from "@/lib/notifications";
import { buildSmsEmail } from "@/lib/notifications";
import SettingsDrawer, {
  loadSettings,
  saveSettings,
  type AppSettings,
} from "@/components/SettingsDrawer";
import RestaurantMonitorCard from "@/components/RestaurantMonitorCard";

// All restaurants monitorable on Resy
const resyRestaurants = restaurants.filter(
  (r) =>
    r.resyUrl !== null &&
    (r.reservationMethod === "resy" || r.reservationMethod === "both"),
);

interface BookingLog {
  id: string;
  restaurantName: string;
  date: string;
  time: string;
  partySize: number;
  status: "success" | "failed";
  error?: string;
  timestamp: string;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** Map day-of-week number (0=Sun) to lowercase day name */
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Filter slots by preferred days and time window from settings */
function filterSlotsBySettings(
  slots: AvailabilitySlot[],
  settings: AppSettings,
): AvailabilitySlot[] {
  const { preferredDays, timeWindowStart, timeWindowEnd } = settings;
  if (preferredDays.length === 0 && !timeWindowStart && !timeWindowEnd) return slots;

  return slots.filter((slot) => {
    // Filter by day of week
    if (preferredDays.length > 0) {
      const d = new Date(slot.date + "T12:00:00");
      const dayName = DAY_NAMES[d.getDay()];
      if (!preferredDays.includes(dayName)) return false;
    }

    // Filter by time window
    if (timeWindowStart && slot.time < timeWindowStart) return false;
    if (timeWindowEnd && slot.time > timeWindowEnd) return false;

    return true;
  });
}

export default function Home() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [resyAuth, setResyAuth] = useState<{
    authenticated: boolean;
    firstName?: string;
    lastName?: string;
  } | null>(null);

  // Monitor state
  const [monitoredIds, setMonitoredIds] = useState<Set<string>>(
    () => new Set(resyRestaurants.map((r) => r.id)),
  );
  const [latestResult, setLatestResult] = useState<MonitorPollResult | null>(null);
  const [allSlots, setAllSlots] = useState<Map<string, AvailabilitySlot[]>>(new Map());
  const [newSlotIds, setNewSlotIds] = useState<Set<string>>(new Set());
  const [pollCount, setPollCount] = useState(0);
  const [isPolling, setIsPolling] = useState(false);
  const [lastPollTime, setLastPollTime] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Scan progress
  const [scanProgress, setScanProgress] = useState<{
    restaurant: string;
    index: number;
    total: number;
  } | null>(null);

  // Per-restaurant auto-book
  const [autoBookIds, setAutoBookIds] = useState<Set<string>>(new Set());

  // Booking
  const [bookingInProgress, setBookingInProgress] = useState<string | null>(null);
  const [bookingLog, setBookingLog] = useState<BookingLog[]>([]);

  // Filter
  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "available" | "monitored">("all");

  // Load settings from localStorage
  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  // Check auth status on load
  useEffect(() => {
    fetch("/api/resy-auth")
      .then((r) => r.json())
      .then(setResyAuth)
      .catch(() => setResyAuth({ authenticated: false }));
  }, []);

  // Tick for time-ago updates
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10000);
    return () => clearInterval(t);
  }, []);

  // Build notification config from settings
  const buildNotificationConfig = useCallback((): NotificationConfig => {
    if (!settings) return {};
    const config: NotificationConfig = {};

    if (settings.notifyEmail && settings.gmailUser && settings.gmailAppPassword) {
      config.email = {
        enabled: true,
        to: settings.notifyEmail,
        gmailUser: settings.gmailUser,
        gmailAppPassword: settings.gmailAppPassword,
      };
    }

    if (settings.smsPhone && settings.smsCarrier && settings.gmailUser && settings.gmailAppPassword) {
      const smsAddr = buildSmsEmail(settings.smsPhone, settings.smsCarrier);
      if (smsAddr) {
        config.email = {
          enabled: true,
          to: smsAddr,
          gmailUser: settings.gmailUser,
          gmailAppPassword: settings.gmailAppPassword,
        };
      }
    }

    return config;
  }, [settings]);

  // Prevent concurrent polls
  const pollInFlight = useRef(false);

  // Poll function — reads NDJSON stream for incremental updates
  const poll = useCallback(async () => {
    if (monitoredIds.size === 0) return;
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    setIsPolling(true);
    setScanProgress(null);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);

      const res = await fetch("/api/resy-monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restaurantIds: Array.from(monitoredIds),
          partySize: settings?.partySize ?? 2,
          resolveIds: true,
          notifications: buildNotificationConfig(),
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok || !res.body) return;

      // Read NDJSON stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const streamNewIds = new Set<string>();
      let streamIsBaseline = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            if (event.type === "progress") {
              setScanProgress({
                restaurant: event.restaurant,
                index: event.index,
                total: event.total,
              });
            } else if (event.type === "result" || event.type === "cached") {
              const diff: SerializableSlotDiff = event.diff;
              // Update slots for this restaurant immediately
              setAllSlots((prev) => {
                const next = new Map(prev);
                next.set(diff.restaurant.id, diff.currentSlots ?? []);
                return next;
              });

              // Track new slot IDs
              if (diff.newSlots.length > 0) {
                for (const slot of diff.newSlots) {
                  streamNewIds.add(slot.id);
                }
                setNewSlotIds(new Set(streamNewIds));
              }
            } else if (event.type === "done") {
              const result: MonitorPollResult = event.pollResult;
              streamIsBaseline = result.isBaseline;
              setLatestResult(result);
              setLastPollTime(new Date().toISOString());
              setPollCount((c) => c + 1);

              // Clear new IDs on baseline
              if (result.isBaseline) {
                setNewSlotIds(new Set());
              }

              // Browser notification
              if (!result.isBaseline) {
                const totalNew = result.diffs.reduce((sum, d) => sum + d.newSlots.length, 0);
                if (totalNew > 0 && typeof Notification !== "undefined" && Notification.permission === "granted") {
                  new Notification("New Resy Reservations!", {
                    body: `${totalNew} new slot${totalNew !== 1 ? "s" : ""} found`,
                    tag: "hopeyeats",
                  });
                }
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
      }

      // Auto-book after stream completes
      if (
        resyAuth?.authenticated &&
        !streamIsBaseline &&
        autoBookIds.size > 0 &&
        latestResult
      ) {
        for (const diff of latestResult.diffs) {
          if (diff.newSlots.length > 0 && autoBookIds.has(diff.restaurant.id)) {
            const slot = diff.newSlots[0];
            handleBook(slot);
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        console.warn("Poll timed out — will retry next cycle");
      } else {
        console.error("Poll error:", err);
      }
    } finally {
      setIsPolling(false);
      setScanProgress(null);
      pollInFlight.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitoredIds, settings, resyAuth, buildNotificationConfig]);

  // Start auto-monitoring on mount
  useEffect(() => {
    if (!settings) return;

    // Request notification permission
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }

    // Initial poll
    poll();

    // Set up interval with jitter
    const baseInterval = 60_000;
    const jitter = baseInterval * (0.85 + Math.random() * 0.3);
    intervalRef.current = setInterval(poll, jitter);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings !== null]);

  // Book a slot
  const handleBook = async (slot: AvailabilitySlot) => {
    setBookingInProgress(slot.id);
    try {
      const res = await fetch("/api/resy-book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          configToken: slot.configToken,
          date: slot.date,
          partySize: settings?.partySize ?? 2,
          restaurantName: slot.venueName,
          time: slot.time,
        }),
      });

      const data = await res.json();
      const log: BookingLog = {
        id: slot.id,
        restaurantName: slot.venueName,
        date: slot.date,
        time: slot.time,
        partySize: settings?.partySize ?? 2,
        status: data.success ? "success" : "failed",
        error: data.error,
        timestamp: new Date().toISOString(),
      };
      setBookingLog((prev) => [log, ...prev].slice(0, 50));
    } catch (err) {
      console.error("Booking error:", err);
    } finally {
      setBookingInProgress(null);
    }
  };

  // Toggle monitoring for a restaurant
  const toggleMonitor = (id: string) => {
    setMonitoredIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        setAutoBookIds((ab) => {
          const nextAb = new Set(ab);
          nextAb.delete(id);
          return nextAb;
        });
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Toggle auto-book for a specific restaurant
  const toggleAutoBook = (id: string) => {
    setAutoBookIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Resy auth handlers
  const handleResyLogin = async (email: string, password: string): Promise<true | string> => {
    try {
      const res = await fetch("/api/resy-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (data.authenticated) {
        setResyAuth(data);
        return true;
      }
      return data.error || "Login failed";
    } catch (err) {
      return err instanceof Error ? err.message : "Network error";
    }
  };

  const handleResyLogout = async () => {
    await fetch("/api/resy-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    setResyAuth({ authenticated: false });
  };

  // Filter & sort restaurants — apply day/time filter to slot counts
  const getFilteredSlots = useCallback(
    (restaurantId: string): AvailabilitySlot[] => {
      const raw = allSlots.get(restaurantId) ?? [];
      if (!settings) return raw;
      return filterSlotsBySettings(raw, settings);
    },
    [allSlots, settings],
  );

  const filtered = resyRestaurants.filter((r) => {
    const filteredSlotCount = getFilteredSlots(r.id).length;
    if (filterMode === "available" && filteredSlotCount === 0) return false;
    if (filterMode === "monitored" && !monitoredIds.has(r.id)) return false;

    if (search) {
      const q = search.toLowerCase();
      return (
        r.name.toLowerCase().includes(q) ||
        r.neighborhood.toLowerCase().includes(q) ||
        r.cuisine.toLowerCase().includes(q)
      );
    }
    return true;
  });

  // Sort: available first, then monitored, then rest
  const sorted = [...filtered].sort((a, b) => {
    const aSlots = getFilteredSlots(a.id).length;
    const bSlots = getFilteredSlots(b.id).length;
    if (aSlots > 0 && bSlots === 0) return -1;
    if (bSlots > 0 && aSlots === 0) return 1;
    return a.name.localeCompare(b.name);
  });

  const totalSlots = resyRestaurants.reduce(
    (sum, r) => sum + getFilteredSlots(r.id).length,
    0,
  );
  const totalNewSlots = newSlotIds.size;

  if (!settings) return null;

  return (
    <div className="min-h-screen bg-cream">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-charcoal text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="font-serif text-2xl tracking-tight">HopeYeats</h1>
              <p className="text-stone-400 text-xs mt-0.5 tracking-wide">
                NYC Restaurant Reservation Monitor
              </p>
            </div>
            <div className="flex items-center gap-4">
              {/* Status pill */}
              <div className="hidden sm:flex items-center gap-2 text-xs text-stone-400">
                <span
                  className={`w-2 h-2 rounded-full ${
                    isPolling
                      ? "bg-amber-400 animate-pulse"
                      : totalSlots > 0
                        ? "bg-emerald-500 animate-pulse"
                        : "bg-stone-500"
                  }`}
                />
                {isPolling
                  ? scanProgress
                    ? `Scanning ${scanProgress.restaurant}...`
                    : "Scanning..."
                  : lastPollTime
                    ? `Poll #${pollCount} · ${timeAgo(lastPollTime)}`
                    : "Starting..."}
              </div>

              {/* Auth indicator */}
              {resyAuth?.authenticated && (
                <span className="hidden sm:inline text-xs text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded-full">
                  {resyAuth.firstName}
                </span>
              )}

              <button
                onClick={() => setShowSettings(true)}
                className="flex items-center gap-2 text-sm text-stone-300 hover:text-white transition-colors border border-stone-700 hover:border-stone-500 px-4 py-2 rounded-lg"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
                Settings
              </button>
            </div>
          </div>
        </div>

        {/* Scan progress bar */}
        {isPolling && scanProgress && (
          <div className="bg-charcoal/90 border-t border-stone-700">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-stone-300">
                      Scanning <strong className="text-white">{scanProgress.restaurant}</strong>
                    </span>
                    <span className="text-stone-400">
                      {scanProgress.index + 1}/{scanProgress.total}
                    </span>
                  </div>
                  <div className="h-1 bg-stone-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gold rounded-full transition-all duration-500"
                      style={{
                        width: `${((scanProgress.index + 1) / scanProgress.total) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Status Bar */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4 text-sm">
            <span className="text-stone-600">
              <strong className="text-charcoal">{monitoredIds.size}</strong> restaurants monitored
            </span>
            {totalSlots > 0 && (
              <span className="text-emerald-600 font-medium">
                {totalSlots} slot{totalSlots !== 1 ? "s" : ""} available
              </span>
            )}
            {totalNewSlots > 0 && (
              <span className="text-emerald-700 font-bold bg-emerald-50 px-2 py-0.5 rounded-full text-xs animate-pulse">
                {totalNewSlots} NEW
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {autoBookIds.size > 0 && (
              <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                Auto-book: {autoBookIds.size} restaurant{autoBookIds.size !== 1 ? "s" : ""}
              </span>
            )}
            <button
              onClick={() =>
                setMonitoredIds(new Set(resyRestaurants.map((r) => r.id)))
              }
              className="text-xs text-stone-400 hover:text-stone-600 underline"
            >
              Monitor All
            </button>
            <button
              onClick={() => { setMonitoredIds(new Set()); setAutoBookIds(new Set()); }}
              className="text-xs text-stone-400 hover:text-stone-600 underline"
            >
              Clear
            </button>
            <button
              onClick={poll}
              disabled={isPolling}
              className="px-3 py-1.5 bg-charcoal text-white rounded-lg text-xs font-medium hover:bg-charcoal/80 transition-colors disabled:opacity-40"
            >
              {isPolling ? "Scanning..." : "Scan Now"}
            </button>
          </div>
        </div>

        {/* Booking Activity */}
        {bookingLog.length > 0 && (
          <div className="mb-6 bg-white border border-stone-200 rounded-2xl p-4">
            <h2 className="text-sm font-semibold text-charcoal mb-2">
              Recent Bookings
            </h2>
            <div className="space-y-1.5 max-h-32 overflow-y-auto">
              {bookingLog.map((log, i) => (
                <div
                  key={i}
                  className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs ${
                    log.status === "success"
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-red-50 text-red-600"
                  }`}
                >
                  <span>
                    {log.status === "success" ? "Booked" : "Failed"}: {log.restaurantName} on {log.date} at {log.time}
                  </span>
                  <span className="text-stone-400">{timeAgo(log.timestamp)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Not authenticated banner */}
        {!resyAuth?.authenticated && (
          <div className="mb-6 bg-gold/10 border border-gold/30 rounded-2xl px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <p className="font-medium text-charcoal">
                Connect your Resy account for auto-booking
              </p>
              <p className="text-sm text-stone-500 mt-0.5">
                Without it, you can still monitor and manually book via Resy links.
              </p>
            </div>
            <button
              onClick={() => setShowSettings(true)}
              className="shrink-0 px-5 py-2.5 bg-charcoal text-white rounded-xl text-sm font-medium hover:bg-charcoal/90 transition-colors"
            >
              Open Settings
            </button>
          </div>
        )}

        {/* Search & Filter */}
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <input
            type="text"
            placeholder="Search restaurants, neighborhoods, cuisines..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 px-4 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50 bg-white"
          />
          <div className="flex gap-1.5">
            {(["all", "available", "monitored"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setFilterMode(mode)}
                className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-colors capitalize ${
                  filterMode === mode
                    ? "bg-charcoal text-white"
                    : "bg-white border border-stone-200 text-stone-500 hover:bg-stone-50"
                }`}
              >
                {mode === "available" ? `Available (${totalSlots})` : mode}
              </button>
            ))}
          </div>
        </div>

        {/* Restaurant Grid */}
        {sorted.length === 0 ? (
          <div className="text-center py-20 text-stone-400">
            <p className="text-lg mb-2">No restaurants match your filters</p>
            <button
              onClick={() => {
                setFilterMode("all");
                setSearch("");
              }}
              className="text-sm underline hover:text-stone-600"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sorted.map((r) => {
              const diff = latestResult?.diffs.find(
                (d) => d.restaurant.id === r.id,
              );
              const filteredSlots = getFilteredSlots(r.id);
              return (
                <RestaurantMonitorCard
                  key={r.id}
                  restaurant={r}
                  slots={filteredSlots}
                  newSlotIds={newSlotIds}
                  isMonitored={monitoredIds.has(r.id)}
                  autoBookEnabled={autoBookIds.has(r.id)}
                  isAuthenticated={resyAuth?.authenticated ?? false}
                  onToggleMonitor={toggleMonitor}
                  onToggleAutoBook={toggleAutoBook}
                  onBook={handleBook}
                  bookingInProgress={bookingInProgress}
                  lastChecked={diff?.checkedAt ?? null}
                />
              );
            })}
          </div>
        )}

        {/* Rate limit info */}
        {latestResult?.rateLimitStats?.isBackedOff && (
          <div className="mt-6 bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 text-sm text-orange-700">
            Rate limited — backing off for{" "}
            {Math.round((latestResult.rateLimitStats.backoffRemaining ?? 0) / 1000)}s
          </div>
        )}

        {/* Footer */}
        <footer className="mt-16 pt-8 border-t border-stone-200 text-center text-xs text-stone-400">
          <p>
            HopeYeats · NYC Restaurant Reservation Sniper · Monitoring{" "}
            {resyRestaurants.length} restaurants on Resy.
          </p>
          <p className="mt-1">
            Your credentials are stored locally in your browser. Resy auth tokens are server-side only.
          </p>
        </footer>
      </main>

      {/* Settings Drawer */}
      <SettingsDrawer
        open={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onSettingsChange={(s) => {
          setSettings(s);
          saveSettings(s);
        }}
        resyAuth={resyAuth}
        onResyLogin={handleResyLogin}
        onResyLogout={handleResyLogout}
      />
    </div>
  );
}
