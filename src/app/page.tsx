"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Link from "next/link";
import { restaurants } from "@/data/restaurants";
import type { AvailabilitySlot } from "@/lib/resyApi";
import type { MonitorPollResult } from "@/lib/resyMonitor";
import type { SerializableSlotDiff } from "@/lib/resyMonitor";
import type { NotificationConfig } from "@/lib/notifications";
import { buildSmsEmail } from "@/lib/notifications";
import SettingsDrawer, {
  loadSettings,
  saveSettings,
  getProfiles,
  getActiveProfile,
  setActiveProfile,
  addProfile,
  deleteProfile,
  DEFAULT_BRUNCH_TIME_WINDOWS,
  type AppSettings,
} from "@/components/SettingsDrawer";
import RestaurantMonitorCard from "@/components/RestaurantMonitorCard";
import LoginPage from "@/components/LoginPage";
import SnipePanel from "@/components/SnipePanel";
import DebugPanel from "@/components/DebugPanel";
import { ToastProvider, useToast } from "@/components/Toast";
import type { LogEntry, LogLevel } from "@/lib/logger";
import { makeTs } from "@/lib/logger";

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

interface ActivityItem {
  id: string;
  restaurant: string;
  slotCount: number;
  newCount: number;
  timestamp: number;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function slotMatchesFilters(slot: AvailabilitySlot, settings: AppSettings): boolean {
  const { preferredDays, dayTimeWindows, blackoutDates } = settings;

  // Check blackout dates
  if (blackoutDates?.length > 0 && blackoutDates.some((bd) => bd.date === slot.date)) {
    return false;
  }

  if (preferredDays.length === 0) return true;

  const d = new Date(slot.date + "T12:00:00");
  const dayName = DAY_NAMES[d.getDay()];
  if (!preferredDays.includes(dayName)) return false;

  const tw = dayTimeWindows?.[dayName];
  if (tw) {
    if (tw.start && slot.time < tw.start) return false;
    if (tw.end && slot.time > tw.end) return false;
  }
  return true;
}

function filterSlotsBySettings(slots: AvailabilitySlot[], settings: AppSettings): AvailabilitySlot[] {
  return slots.filter((slot) => slotMatchesFilters(slot, settings));
}

export default function Home() {
  return (
    <ToastProvider>
      <HomeInner />
    </ToastProvider>
  );
}

function HomeInner() {
  const { addToast } = useToast();
  // --- Multi-user profile state ---
  const [profiles, setProfiles] = useState<string[]>([]);
  const [activeProfileName, setActiveProfileName] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [resyAuth, setResyAuth] = useState<{
    authenticated: boolean;
    firstName?: string;
    lastName?: string;
    authToken?: string;
  } | null>(null);

  const [monitoredIds, setMonitoredIds] = useState<Set<string>>(
    () => new Set(resyRestaurants.map((r) => r.id)),
  );
  const [latestResult, setLatestResult] = useState<MonitorPollResult | null>(null);
  const [allSlots, setAllSlots] = useState<Map<string, AvailabilitySlot[]>>(new Map());
  const [lastCheckedMap, setLastCheckedMap] = useState<Map<string, string>>(new Map());
  const [newSlotIds, setNewSlotIds] = useState<Set<string>>(new Set());
  const [pollCount, setPollCount] = useState(0);
  const [isPolling, setIsPolling] = useState(false);
  const [lastPollTime, setLastPollTime] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [scanProgress, setScanProgress] = useState<{ restaurant: string; index: number; total: number } | null>(null);
  const [activityFeed, setActivityFeed] = useState<ActivityItem[]>([]);
  const [autoBookIds, setAutoBookIds] = useState<Set<string>>(new Set());
  const [bookingInProgress, setBookingInProgress] = useState<string | null>(null);
  const [bookingLog, setBookingLog] = useState<BookingLog[]>([]);
  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "available" | "monitored">("all");
  const [cityFilter, setCityFilter] = useState<"all" | "nyc" | "miami" | "hamptons">("all");
  const [mealFilter, setMealFilter] = useState<"all" | "dinner" | "bar" | "brunch">("all");
  const [activePartySize, setActivePartySize] = useState<2 | 4>(4);
  const [loggedInUser, setLoggedInUser] = useState<string | null>(null);
  const [appMode, setAppMode] = useState<"monitor" | "snipe">("monitor");
  const [debugLog, setDebugLog] = useState<LogEntry[]>([]);
  const [showDebugLog, setShowDebugLog] = useState(false);
  const [consecutiveFails, setConsecutiveFails] = useState(0);

  const addLog = useCallback((level: LogLevel, module: string, msg: string, data?: Record<string, unknown>) => {
    const ts = makeTs();
    setDebugLog((prev) => [{ ts, level, module, msg, ...(data ? { data } : {}) }, ...prev].slice(0, 200));
  }, []);

  // Global error capture
  useEffect(() => {
    const onError = (e: ErrorEvent) => addLog("error", "ui", e.message, { file: e.filename, line: e.lineno });
    const onReject = (e: PromiseRejectionEvent) => addLog("error", "ui", `Unhandled rejection: ${String(e.reason)}`);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onReject);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onReject);
    };
  }, [addLog]);

  // Refs for latest values (avoid stale closures)
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const mealFilterRef = useRef(mealFilter);
  mealFilterRef.current = mealFilter;

  // --- Initialize profiles on mount ---
  useEffect(() => {
    let profs = getProfiles();
    let active = getActiveProfile();

    // Auto-create default profile if none exist
    if (profs.length === 0) {
      addProfile("Default");
      profs = ["Default"];
    }
    if (!active || !profs.includes(active)) {
      active = profs[0];
      setActiveProfile(active);
    }

    setProfiles(profs);
    setActiveProfileName(active);
    const s = loadSettings(active);
    setSettings(s);

    // Restore per-user monitored and autobook
    if (s.monitoredIds.length > 0) {
      setMonitoredIds(new Set(s.monitoredIds));
    }
    if (s.autoBookIds.length > 0) {
      setAutoBookIds(new Set(s.autoBookIds));
    }
    if (s.partySize === 2 || s.partySize === 4) {
      setActivePartySize(s.partySize as 2 | 4);
    }
  }, []);

  // --- Persist autoBookIds and monitoredIds to settings ---
  const persistUserState = useCallback((monitored: Set<string>, autoBook: Set<string>) => {
    const currentSettings = settingsRef.current;
    if (!currentSettings || !activeProfileName) return;
    const next = { ...currentSettings, monitoredIds: Array.from(monitored), autoBookIds: Array.from(autoBook) };
    setSettings(next);
    saveSettings(next);
  }, [activeProfileName]);

  // --- Auth restore ---
  const authRestoreAttempted = useRef(false);
  useEffect(() => {
    if (!settings || authRestoreAttempted.current) return;
    authRestoreAttempted.current = true;

    if (settings.resyAuthToken) {
      fetch("/api/resy-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authToken: settings.resyAuthToken }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.authenticated) {
            setResyAuth(data);
            addLog("success", "auth", `Token restored — ${data.firstName ?? ""} ${data.lastName ?? ""}`.trim());
          } else {
            setSettings((prev) => prev ? { ...prev, resyAuthToken: "" } : prev);
            if (settings) saveSettings({ ...settings, resyAuthToken: "" });
            setResyAuth({ authenticated: false });
            addLog("warn", "auth", "Saved token invalid — cleared");
          }
        })
        .catch(() => {
          setResyAuth({ authenticated: false });
          addLog("error", "auth", "Token restore failed — network error");
        });
    } else {
      // No saved token — mark as unauthenticated without hitting the server
      setResyAuth({ authenticated: false });
    }
  }, [settings]);

  // Tick for "X ago" updates
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10000);
    return () => clearInterval(t);
  }, []);

  const buildNotificationConfig = useCallback((): NotificationConfig => {
    if (!settings) return {};
    const config: NotificationConfig = {};
    if (settings.notifyEmail && settings.gmailUser && settings.gmailAppPassword) {
      config.email = { enabled: true, to: settings.notifyEmail, gmailUser: settings.gmailUser, gmailAppPassword: settings.gmailAppPassword };
    }
    if (settings.smsPhone && settings.smsCarrier && settings.gmailUser && settings.gmailAppPassword) {
      const smsAddr = buildSmsEmail(settings.smsPhone, settings.smsCarrier);
      if (smsAddr) {
        config.email = { enabled: true, to: smsAddr, gmailUser: settings.gmailUser, gmailAppPassword: settings.gmailAppPassword };
      }
    }
    return config;
  }, [settings]);

  // --- Polling ---
  const pollInFlight = useRef(false);
  const pollCycleRef = useRef(0);
  const resyAuthRef = useRef(resyAuth);
  resyAuthRef.current = resyAuth;

  const poll = useCallback(async () => {
    if (monitoredIds.size === 0) return;
    if (pollInFlight.current) return;
    // Don't poll until user is authenticated with Resy
    const currentAuth = resyAuthRef.current;
    if (!currentAuth?.authenticated) return;
    pollInFlight.current = true;
    setIsPolling(true);
    setScanProgress(null);
    setActivityFeed([]);
    const currentSettings = settingsRef.current;
    const cycle = pollCycleRef.current++;

    // Smart polling: auto-book restaurants checked every poll, others rotated
    // Cycle 0 = baseline (all restaurants). Subsequent cycles rotate monitor-only
    // in groups of ~10 to reduce per-poll request volume (avoids WAF blocking).
    const tier1 = Array.from(autoBookIds); // checked every poll
    const allMonitor = Array.from(monitoredIds).filter(id => !autoBookIds.has(id));
    let tier2: string[];
    if (cycle === 0) {
      // Baseline: check everyone
      tier2 = allMonitor;
    } else {
      // Rotate through monitor-only restaurants in groups of ~10
      const GROUP_SIZE = 10;
      const numGroups = Math.ceil(allMonitor.length / GROUP_SIZE);
      const groupIdx = cycle % Math.max(numGroups, 1);
      tier2 = allMonitor.slice(groupIdx * GROUP_SIZE, (groupIdx + 1) * GROUP_SIZE);
    }
    const restaurantIds = [...tier1, ...tier2];
    const dateLimits: Record<string, number> = {};
    for (const id of tier1) dateLimits[id] = 3;
    for (const id of tier2) dateLimits[id] = 3;

    addLog("info", "poll", `Poll #${cycle} start — ${restaurantIds.length} restaurants`, { tier1: tier1.length, tier2: tier2.length });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);

      // Build time filters — swap to brunch windows when brunch mode is active
      const isBrunch = mealFilterRef.current === "brunch";
      const timeFilters = currentSettings ? {
        preferredDays: isBrunch ? ["saturday", "sunday"] : currentSettings.preferredDays,
        dayTimeWindows: isBrunch ? DEFAULT_BRUNCH_TIME_WINDOWS : currentSettings.dayTimeWindows,
        blackoutDates: currentSettings.blackoutDates,
      } : undefined;

      const res = await fetch("/api/resy-monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restaurantIds,
          dateLimits,
          partySize: currentSettings?.partySize ?? 4,
          resolveIds: true,
          notifications: buildNotificationConfig(),
          authToken: currentAuth?.authToken,
          // Inline auto-book config (Option C — booking happens server-side in same instance)
          autoBookIds: tier1.length > 0 && currentAuth?.authenticated ? tier1 : undefined,
          timeFilters,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok || !res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const streamNewIds = new Set<string>();
      let streamIsBaseline = true;
      const streamDiffs: SerializableSlotDiff[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            if (event.type === "progress") {
              setScanProgress({ restaurant: event.restaurant, index: event.index, total: event.total });
            } else if (event.type === "result" || event.type === "cached") {
              const diff: SerializableSlotDiff = event.diff;
              streamDiffs.push(diff);

              setAllSlots((prev) => {
                const next = new Map(prev);
                // Only update if we got actual data — don't wipe slots on empty poll (500 = no data, not "no availability")
                const newSlots = diff.currentSlots ?? [];
                const existing = prev.get(diff.restaurant.id) ?? [];
                if (newSlots.length > 0 || existing.length === 0) {
                  next.set(diff.restaurant.id, newSlots);
                }
                // If newSlots is empty but we had existing slots, keep them (API might have returned 500)
                return next;
              });

              setLastCheckedMap((prev) => {
                const next = new Map(prev);
                next.set(diff.restaurant.id, diff.checkedAt);
                return next;
              });

              // Only count new slots that match user's time filters
              if (diff.newSlots.length > 0 && currentSettings) {
                for (const slot of diff.newSlots) {
                  if (slotMatchesFilters(slot, currentSettings)) {
                    streamNewIds.add(slot.id);
                  }
                }
                setNewSlotIds(new Set(streamNewIds));
              }
            } else if (event.type === "activity") {
              // Use filtered counts from current stream diffs
              const restaurantId = resyRestaurants.find((r) => r.name === event.restaurant)?.id;
              const streamDiff = restaurantId ? streamDiffs.find((d) => d.restaurant.id === restaurantId) : null;
              const rawSlots = streamDiff?.currentSlots ?? [];
              const filteredSlots = currentSettings ? filterSlotsBySettings(rawSlots, currentSettings) : rawSlots;
              const filteredNew = streamDiff && currentSettings
                ? streamDiff.newSlots.filter((s) => slotMatchesFilters(s, currentSettings)).length
                : event.newCount;

              if (filteredSlots.length > 0) {
                setActivityFeed((prev) => [
                  {
                    id: `${event.restaurant}-${Date.now()}`,
                    restaurant: event.restaurant,
                    slotCount: filteredSlots.length,
                    newCount: filteredNew,
                    timestamp: Date.now(),
                  },
                  ...prev,
                ].slice(0, 10));
              }
            } else if (event.type === "booking") {
                          // Inline auto-book result from server (Option C)
                          const log: BookingLog = {
                            id: `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                            restaurantName: event.restaurant,
                            date: event.date,
                            time: event.time,
                            partySize: currentSettings?.partySize ?? 4,
                            status: event.success ? "success" : "failed",
                            error: event.error,
                            timestamp: new Date().toISOString(),
                          };
                          setBookingLog((prev) => [log, ...prev].slice(0, 50));
                          addLog(event.success ? "success" : "error", "book", `AutoBook ${event.success ? "booked" : "failed"} — ${event.restaurant} ${event.date} ${event.time}`, event.success ? undefined : { error: event.error });
                          if (event.success) {
                            addToast(`Auto-booked ${event.restaurant} — ${event.date} at ${event.time}`, "success", 8000);
                          } else {
                            addToast(`Auto-book failed: ${event.restaurant} — ${event.error ?? "unknown error"}`, "error", 5000);
                          }
            } else if (event.type === "done") {
              const result: MonitorPollResult = event.pollResult;
              streamIsBaseline = result.isBaseline;
              setLatestResult(result);
              setLastPollTime(new Date().toISOString());
              setPollCount((c) => c + 1);

              const totalSlots = result.diffs.reduce((s, d) => s + (d.currentSlots?.length ?? 0), 0);
              const totalNew = result.diffs.reduce((s, d) => s + d.newSlots.length, 0);
              // Exclude bar-only restaurants from the avail summary (e.g. The Mulberry)
              const withSlots = result.diffs
                .filter((d) => (d.currentSlots?.length ?? 0) > 0)
                .filter((d) => { const r = resyRestaurants.find(x => x.id === d.restaurant.id); return !r || !r.category || r.category.some(c => c !== "bar"); })
                .map((d) => d.restaurant.name);

              // Track consecutive all-fail polls for exponential backoff
              // Parse diagnostics string for 200 status count (format: "statuses={200:N,...}")
              const had200s = result.diagnostics?.includes("200:") ?? false;
              if (had200s) {
                if (consecutiveFailsRef.current !== 0) {
                  consecutiveFailsRef.current = 0;
                  setConsecutiveFails(0);
                }
              } else if (result.diffs.length > 0) {
                consecutiveFailsRef.current++;
                setConsecutiveFails(consecutiveFailsRef.current);
                if (consecutiveFailsRef.current > 1) {
                  addLog("warn", "poll", `WAF blocked — backing off`, { fails: consecutiveFailsRef.current });
                }
              }

              addLog("info", "poll", `Poll #${cycle} done — ${result.diffs.length} checked, ${totalSlots} slots, ${totalNew} new`, {
                baseline: result.isBaseline,
                avail: withSlots.length > 0 ? withSlots : undefined,
              });
              if (result.diagnostics) {
                addLog("debug", "poll", `Diagnostics: ${result.diagnostics}`);
              }

              if (result.isBaseline) {
                setNewSlotIds(new Set());
              }

              // Only notify for filtered new slots
              if (!result.isBaseline && currentSettings) {
                const filteredNewCount = result.diffs.reduce((sum, d) => {
                  return sum + d.newSlots.filter((s) => slotMatchesFilters(s, currentSettings)).length;
                }, 0);
                if (filteredNewCount > 0 && typeof Notification !== "undefined" && Notification.permission === "granted") {
                  new Notification("New Resy Reservations!", {
                    body: `${filteredNewCount} new slot${filteredNewCount !== 1 ? "s" : ""} matching your preferences`,
                    tag: "wolfepack-eats",
                  });
                }
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
      }

      // Auto-book now happens server-side (Option C — inline in monitor route)
      // Client just handles "booking" events from the NDJSON stream above
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        addLog("warn", "poll", "Poll timed out — will retry next cycle");
      } else {
        addLog("error", "poll", "Poll error", { error: err instanceof Error ? err.message : String(err) });
        console.error("[WolfePack] Poll error:", err);
      }
    } finally {
      setIsPolling(false);
      setScanProgress(null);
      pollInFlight.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitoredIds, settings, resyAuth, buildNotificationConfig]);

  // Only start polling when: settings loaded AND Resy auth fully resolved AND authenticated
  const resyAuthenticated = resyAuth?.authenticated === true;
  const consecutiveFailsRef = useRef(0);
  useEffect(() => {
    if (!settings || !resyAuthenticated) return;
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
    poll();
    // Dynamic interval with exponential backoff after consecutive all-500 polls
    const scheduleNext = () => {
      const fails = consecutiveFailsRef.current;
      const baseInterval = 60_000 * (1.0 + Math.random() * 0.3); // 60-78s
      const backoffMultiplier = fails > 0 ? Math.min(Math.pow(2, fails), 8) : 1; // 2x, 4x, 8x max
      const interval = baseInterval * backoffMultiplier;
      if (fails > 0) {
        console.log(`[WolfePack] Backing off: ${Math.round(interval / 1000)}s (${fails} consecutive failures)`);
      }
      intervalRef.current = setTimeout(() => {
        poll();
        scheduleNext();
      }, interval);
    };
    scheduleNext();
    return () => { if (intervalRef.current) clearTimeout(intervalRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings !== null, resyAuthenticated]);

  // --- Handlers ---

  const handleBook = async (slot: AvailabilitySlot, skipConflictCheck = false) => {
    setBookingInProgress(slot.id);
    try {
      const res = await fetch("/api/resy-book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          configToken: slot.configToken,
          date: slot.date,
          partySize: settings?.partySize ?? 4,
          restaurantName: slot.venueName,
          time: slot.time,
          authToken: resyAuth?.authToken,
          skipConflictCheck,
        }),
      });
      const data = await res.json();

      // Meal-period conflict — ask user to confirm override
      if (res.status === 409 && data.conflict) {
        setBookingInProgress(null);
        const dayLabel = new Date(data.existingDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        const confirmed = window.confirm(
          `You already have a reservation at ${data.existingVenue} on ${dayLabel}.\n\nBook ${slot.venueName} instead?`
        );
        if (confirmed) {
          handleBook(slot, true);
        }
        return;
      }

      const log: BookingLog = {
        id: slot.id, restaurantName: slot.venueName, date: slot.date, time: slot.time,
        partySize: settings?.partySize ?? 4, status: data.success ? "success" : "failed",
        error: data.error, timestamp: new Date().toISOString(),
      };
      setBookingLog((prev) => [log, ...prev].slice(0, 50));
      if (data.success) {
        addToast(`Booked ${slot.venueName} — ${slot.date} at ${slot.time}`, "success", 8000);
      } else {
        addToast(`Booking failed: ${data.error ?? "Unknown error"}`, "error", 6000);
      }
    } catch {
      addToast(`Booking error for ${slot.venueName}`, "error");
    } finally {
      setBookingInProgress(null);
    }
  };

  const toggleMonitor = (id: string) => {
    setMonitoredIds((prev) => {
      const next = new Set(prev);
      let nextAuto = autoBookIds;
      if (next.has(id)) {
        next.delete(id);
        nextAuto = new Set(autoBookIds);
        nextAuto.delete(id);
        setAutoBookIds(nextAuto);
      } else {
        next.add(id);
      }
      persistUserState(next, nextAuto);
      return next;
    });
  };

  const toggleAutoBook = (id: string) => {
    setAutoBookIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistUserState(monitoredIds, next);
      return next;
    });
  };

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
        addLog("success", "auth", `Email login — ${data.firstName ?? ""} ${data.lastName ?? ""}`.trim());
        return true;
      }
      addLog("error", "auth", `Email login failed — ${data.error ?? "unknown"}`);
      return data.error || "Login failed";
    } catch (err) {
      addLog("error", "auth", "Email login error", { error: err instanceof Error ? err.message : String(err) });
      return err instanceof Error ? err.message : "Network error";
    }
  };

  const handleResyTokenAuth = async (token: string): Promise<true | string> => {
    try {
      const res = await fetch("/api/resy-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authToken: token }),
      });
      const data = await res.json();
      if (data.authenticated) {
        setResyAuth(data);
        addLog("success", "auth", `Token auth — ${data.firstName ?? ""} ${data.lastName ?? ""}`.trim());
        return true;
      }
      addLog("error", "auth", `Token auth failed — ${data.error ?? "unknown"}`);
      return data.error || "Token validation failed";
    } catch (err) {
      addLog("error", "auth", "Token auth error", { error: err instanceof Error ? err.message : String(err) });
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
    addLog("info", "auth", "Logged out");
  };

  const handleSwitchProfile = (name: string) => {
    setActiveProfile(name);
    setActiveProfileName(name);
    authRestoreAttempted.current = false;
    const s = loadSettings(name);
    setSettings(s);
    setResyAuth(null);
    if (s.monitoredIds.length > 0) setMonitoredIds(new Set(s.monitoredIds));
    else setMonitoredIds(new Set(resyRestaurants.map((r) => r.id)));
    if (s.autoBookIds.length > 0) setAutoBookIds(new Set(s.autoBookIds));
    else setAutoBookIds(new Set());
    // Clear slot state on profile switch
    setAllSlots(new Map());
    setNewSlotIds(new Set());
    setLastCheckedMap(new Map());
    setPollCount(0);
  };

  const handleCreateProfile = (name: string) => {
    addProfile(name);
    setProfiles(getProfiles());
    handleSwitchProfile(name);
  };

  const handleDeleteProfile = (name: string) => {
    deleteProfile(name);
    const remaining = getProfiles();
    setProfiles(remaining.length > 0 ? remaining : ["Default"]);
    if (remaining.length === 0) {
      addProfile("Default");
      setProfiles(["Default"]);
    }
    handleSwitchProfile(remaining.length > 0 ? remaining[0] : "Default");
  };

  // --- Memoized derived values ---

  const debugErrorCount = useMemo(
    () => debugLog.filter((e) => e.level === "error").length,
    [debugLog],
  );
  const monitoredNames = useMemo(
    () => resyRestaurants.filter((r) => monitoredIds.has(r.id)).map((r) => r.name),
    [monitoredIds],
  );
  const autoBookNames = useMemo(
    () => resyRestaurants.filter((r) => autoBookIds.has(r.id)).map((r) => r.name),
    [autoBookIds],
  );

  const getFilteredSlots = useCallback(
    (restaurantId: string): AvailabilitySlot[] => {
      const raw = allSlots.get(restaurantId) ?? [];
      if (!settings) return raw;
      return filterSlotsBySettings(raw, settings);
    },
    [allSlots, settings],
  );

  const filtered = resyRestaurants.filter((r) => {
    const cnt = getFilteredSlots(r.id).length;
    if (filterMode === "available" && cnt === 0) return false;
    if (filterMode === "monitored" && !monitoredIds.has(r.id)) return false;
    if (cityFilter !== "all" && (r as any).city !== cityFilter) return false;
    if (mealFilter !== "all" && !(r as any).category?.includes(mealFilter)) return false;
    if (search) {
      const q = search.toLowerCase();
      return r.name.toLowerCase().includes(q) || r.neighborhood.toLowerCase().includes(q) || r.cuisine.toLowerCase().includes(q);
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const aSlots = getFilteredSlots(a.id).length;
    const bSlots = getFilteredSlots(b.id).length;
    if (aSlots > 0 && bSlots === 0) return -1;
    if (bSlots > 0 && aSlots === 0) return 1;
    return a.name.localeCompare(b.name);
  });

  const totalSlots = resyRestaurants.reduce((sum, r) => sum + getFilteredSlots(r.id).length, 0);
  const totalNewSlots = newSlotIds.size;
  const isAdmin = loggedInUser?.toLowerCase() === "garrett";

  if (!settings) return null;

  // Show login page if user hasn't logged in yet
  if (!loggedInUser) {
    return (
      <LoginPage
        onLogin={(username) => {
          setLoggedInUser(username);
          const existing = getProfiles();
          if (!existing.includes(username)) {
            handleCreateProfile(username);
          } else {
            handleSwitchProfile(username);
          }
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-cream">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-charcoal text-white">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-3 sm:py-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <h1 className="font-serif text-xl sm:text-2xl tracking-tight">WolfePack Eats</h1>
              <p className="text-stone-400 text-[10px] sm:text-xs mt-0.5 tracking-wide truncate">
                {activeProfileName && <span className="text-stone-300">{activeProfileName}</span>}
                {activeProfileName && " · "}
                Monitoring {monitoredIds.size} restaurants
              </p>
            </div>
            <div className="flex items-center gap-2 sm:gap-4">
              {/* Status indicator */}
              <div className="flex items-center gap-1.5 text-[10px] sm:text-xs text-stone-400">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    isPolling ? "bg-amber-400 animate-pulse"
                      : totalSlots > 0 ? "bg-emerald-500 animate-pulse"
                        : "bg-stone-500"
                  }`}
                />
                <span className="hidden sm:inline">
                  {isPolling
                    ? scanProgress ? `Scanning ${scanProgress.restaurant.split(",")[0]}...` : "Scanning..."
                    : lastPollTime ? `Poll #${pollCount} · ${timeAgo(lastPollTime)}` : "Starting..."}
                </span>
              </div>

              {resyAuth?.authenticated && (
                <span className="hidden sm:inline text-xs text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded-full">
                  {resyAuth.firstName}
                </span>
              )}

              {/* Admin: profile switcher (Garrett only) */}
              {isAdmin && profiles.length > 1 && (
                <select
                  value={activeProfileName ?? ""}
                  onChange={(e) => handleSwitchProfile(e.target.value)}
                  className="text-xs bg-stone-800 text-stone-300 border border-stone-600 rounded-lg px-2 py-1.5"
                >
                  {profiles.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              )}

              <button
                onClick={() => setShowSettings(true)}
                className="flex items-center gap-1.5 text-sm text-stone-300 hover:text-white transition-colors border border-stone-700 hover:border-stone-500 px-2.5 sm:px-4 py-2 rounded-lg"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="hidden sm:inline">Settings</span>
              </button>

              <button
                onClick={() => setLoggedInUser(null)}
                className="text-xs text-stone-500 hover:text-stone-300 transition-colors"
                title="Logout"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Progress bar + activity feed */}
        {isPolling && (
          <div className="bg-charcoal/90 border-t border-stone-700">
            <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-2">
              {scanProgress && (
                <div className="mb-2">
                  <div className="flex items-center justify-between text-[10px] sm:text-xs mb-1">
                    <span className="text-stone-300 truncate">
                      Scanning <strong className="text-white">{scanProgress.restaurant.split(",")[0]}</strong>
                    </span>
                    <span className="text-stone-400 shrink-0 ml-2">
                      {Math.min(scanProgress.index + scanProgress.restaurant.split(",").length, scanProgress.total)}/{scanProgress.total}
                    </span>
                  </div>
                  <div className="h-1 bg-stone-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gold rounded-full transition-all duration-500"
                      style={{ width: `${(Math.min(scanProgress.index + scanProgress.restaurant.split(",").length, scanProgress.total) / scanProgress.total) * 100}%` }}
                    />
                  </div>
                </div>
              )}
              {activityFeed.length > 0 && (
                <div className="flex flex-wrap gap-1.5 text-[10px] sm:text-xs">
                  {activityFeed.slice(0, 4).map((item) => (
                    <span key={item.id} className="text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full">
                      {item.restaurant.split(",")[0]}: {item.slotCount} slot{item.slotCount !== 1 ? "s" : ""}
                      {item.newCount > 0 && <span className="text-emerald-300 font-bold"> +{item.newCount}</span>}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </header>

      <main className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6">
        {/* Status Bar */}
        <div className="mb-4 sm:mb-6 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3 text-sm">
            <span className="text-stone-600">
              <strong className="text-charcoal">{monitoredIds.size}</strong> monitored
            </span>
            {totalSlots > 0 && (
              <span className="text-emerald-600 font-medium">
                {totalSlots} slot{totalSlots !== 1 ? "s" : ""}
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
              <span className="text-[10px] sm:text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                Auto-book: {autoBookIds.size}
              </span>
            )}
            <button
              onClick={() => { const all = new Set(resyRestaurants.map((r) => r.id)); setMonitoredIds(all); persistUserState(all, autoBookIds); }}
              className="text-xs text-stone-400 hover:text-stone-600 underline hidden sm:inline"
            >
              All
            </button>
            <button
              onClick={() => { setMonitoredIds(new Set()); setAutoBookIds(new Set()); persistUserState(new Set(), new Set()); }}
              className="text-xs text-stone-400 hover:text-stone-600 underline hidden sm:inline"
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
          <div className="mb-4 bg-white border border-stone-200 rounded-2xl p-3 sm:p-4">
            <h2 className="text-sm font-semibold text-charcoal mb-2">Recent Bookings</h2>
            <div className="space-y-1.5 max-h-28 overflow-y-auto">
              {bookingLog.map((log, i) => (
                <div
                  key={i}
                  className={`flex items-center justify-between px-3 py-1.5 rounded-lg text-xs ${
                    log.status === "success" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"
                  }`}
                >
                  <span className="truncate">{log.status === "success" ? "Booked" : "Failed"}: {log.restaurantName} {log.date} {log.time}</span>
                  <span className="text-stone-400 shrink-0 ml-2">{timeAgo(log.timestamp)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Debug Log */}
        <div className="mb-4">
          <button
            onClick={() => setShowDebugLog(!showDebugLog)}
            className="text-xs text-stone-400 hover:text-stone-600 transition-colors flex items-center gap-1 mb-2"
          >
            {showDebugLog ? "▼" : "▶"} Debug Log ({debugLog.length})
            {debugErrorCount > 0 && (
              <span className="ml-1 px-1.5 py-0.5 bg-red-900 text-red-300 rounded text-[9px] font-medium">
                {debugErrorCount} errors
              </span>
            )}
          </button>
          {showDebugLog && (
            <DebugPanel
              entries={debugLog}
              onClear={() => setDebugLog([])}
              resyAuth={resyAuth}
              profile={activeProfileName}
              partySize={settings?.partySize ?? 4}
              monitoredCount={monitoredIds.size}
              monitoredNames={monitoredNames}
              autoBookNames={autoBookNames}
              pollCount={pollCount}
              lastPollTime={lastPollTime}
              isPolling={isPolling}
              preferredDays={settings?.preferredDays ?? []}
              consecutiveFails={consecutiveFails}
            />
          )}
        </div>

        {/* Auth banner */}
        {!resyAuth?.authenticated && (
          <div className="mb-4 sm:mb-6 bg-gold/10 border border-gold/30 rounded-2xl px-4 sm:px-6 py-3 sm:py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <p className="font-medium text-charcoal text-sm">Connect your Resy account</p>
              <p className="text-xs text-stone-500 mt-0.5">Required for auto-booking. Monitor mode works without it.</p>
            </div>
            <button
              onClick={() => setShowSettings(true)}
              className="shrink-0 px-4 py-2 bg-charcoal text-white rounded-xl text-sm font-medium hover:bg-charcoal/90 transition-colors"
            >
              Settings
            </button>
          </div>
        )}

        {/* Mode Toggle: Monitor vs Snipe vs Notify */}
        <div className="flex flex-wrap gap-1 mb-4">
          {([["monitor", "Availability Monitor"], ["snipe", "Snipe Mode"]] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setAppMode(key)}
              className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                appMode === key
                  ? key === "snipe" ? "bg-red-600 text-white" : "bg-charcoal text-white"
                  : "bg-white border border-stone-200 text-stone-500 hover:bg-stone-50"
              }`}
            >
              {key === "snipe" && "⚡ "}{label}
            </button>
          ))}
          <Link
            href="/notify"
            className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors bg-white border border-stone-200 text-stone-500 hover:bg-orange-50 hover:border-orange-300 hover:text-orange-700"
          >
            🔔 Notify
          </Link>
        </div>

        {/* Snipe Panel (Mode 1) */}
        {appMode === "snipe" && (
          <div className="mb-6">
            <SnipePanel
              restaurants={resyRestaurants}
              isAuthenticated={resyAuth?.authenticated ?? false}
              authToken={resyAuth?.authToken}
              partySize={settings.partySize ?? 4}
              dayTimeWindows={mealFilter === "brunch" ? DEFAULT_BRUNCH_TIME_WINDOWS : settings.dayTimeWindows}
              preferredDays={mealFilter === "brunch" ? ["saturday", "sunday"] : settings.preferredDays}
              onLog={(level, msg, data) => addLog(level, "snipe", msg, data)}
              onBooked={(event) => {
                addToast(`Sniped! ${event.restaurant} at ${event.time} on ${event.date}`, "success", 10000);
                setBookingLog((prev) => [{
                  id: `snipe-${Date.now()}`,
                  restaurantName: String(event.restaurant),
                  date: String(event.date),
                  time: String(event.time),
                  partySize: settings.partySize ?? 4,
                  status: "success" as const,
                  timestamp: new Date().toISOString(),
                }, ...prev].slice(0, 50));
              }}
            />
          </div>
        )}

        {appMode === "monitor" && (<>
        {/* City Tabs */}
        <div className="flex flex-wrap gap-1 mb-3">
          {([["all", "All Cities"], ["nyc", "NYC"], ["miami", "Miami"], ["hamptons", "Hamptons"]] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setCityFilter(key as typeof cityFilter)}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                cityFilter === key
                  ? "bg-charcoal text-white"
                  : "bg-white border border-stone-200 text-stone-500 hover:bg-stone-50"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Meal Type + Party Size Row */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="flex gap-1">
            {([["all", "All"], ["dinner", "Dinner"], ["bar", "Bar"], ["brunch", "Brunch"]] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setMealFilter(key as typeof mealFilter)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  mealFilter === key
                    ? "bg-gold text-white"
                    : "bg-white border border-stone-200 text-stone-500 hover:bg-stone-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-xs text-stone-400">Party:</span>
            {([2, 4] as const).map((size) => (
              <button
                key={size}
                onClick={() => {
                  setActivePartySize(size);
                  if (settings) {
                    const next = { ...settings, partySize: size };
                    setSettings(next);
                    saveSettings(next);
                  }
                }}
                className={`w-8 h-8 rounded-lg text-sm font-medium transition-colors ${
                  activePartySize === size
                    ? "bg-charcoal text-white"
                    : "bg-white border border-stone-200 text-stone-500 hover:bg-stone-50"
                }`}
              >
                {size}
              </button>
            ))}
          </div>
        </div>

        {/* Search & Filter */}
        <div className="flex flex-col sm:flex-row gap-2 mb-4 sm:mb-6">
          <input
            type="text"
            placeholder="Search restaurants..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 px-3 sm:px-4 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50 bg-white"
          />
          <div className="flex gap-1">
            {(["all", "available", "monitored"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setFilterMode(mode)}
                className={`px-3 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-medium transition-colors capitalize ${
                  filterMode === mode
                    ? "bg-charcoal text-white"
                    : "bg-white border border-stone-200 text-stone-500 hover:bg-stone-50"
                }`}
              >
                {mode === "available" ? `Avail (${totalSlots})` : mode}
              </button>
            ))}
          </div>
        </div>

        {/* Restaurant Grid */}
        {sorted.length === 0 ? (
          <div className="text-center py-16 text-stone-400">
            <p className="text-base mb-2">No restaurants match</p>
            <button
              onClick={() => { setFilterMode("all"); setSearch(""); }}
              className="text-sm underline hover:text-stone-600"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            {sorted.map((r) => (
              <RestaurantMonitorCard
                key={r.id}
                restaurant={r}
                slots={getFilteredSlots(r.id)}
                newSlotIds={newSlotIds}
                isMonitored={monitoredIds.has(r.id)}
                autoBookEnabled={autoBookIds.has(r.id)}
                isAuthenticated={resyAuth?.authenticated ?? false}
                onToggleMonitor={toggleMonitor}
                onToggleAutoBook={toggleAutoBook}
                onBook={handleBook}
                bookingInProgress={bookingInProgress}
                lastChecked={lastCheckedMap.get(r.id) ?? null}
                partySize={settings?.partySize ?? 4}
                lastBookingFailure={(() => {
                  // #13: Find most recent failure for this restaurant (only if no subsequent success)
                  const logs = bookingLog.filter(l => l.restaurantName === r.name);
                  if (logs.length === 0) return null;
                  const latest = logs[0]; // bookingLog is newest-first
                  if (latest.status === "success") return null;
                  return { time: latest.time, error: latest.error ?? "Unknown error", timestamp: latest.timestamp };
                })()}
              />
            ))}
          </div>
        )}

        {latestResult?.rateLimitStats?.isBackedOff && (
          <div className="mt-4 bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 text-sm text-orange-700">
            Rate limited — backing off {Math.round((latestResult.rateLimitStats.backoffRemaining ?? 0) / 1000)}s
          </div>
        )}
        </>)}

        <footer className="mt-12 pt-6 border-t border-stone-200 text-center text-[10px] sm:text-xs text-stone-400 pb-4">
          <p>WolfePack Eats · Monitoring {resyRestaurants.length} restaurants on Resy</p>
        </footer>
      </main>

      <SettingsDrawer
        open={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onSettingsChange={(s) => {
          // Preserve monitoredIds/autoBookIds from React state — SettingsDrawer
          // doesn't manage these, so its copy may be stale/empty
          const merged = { ...s, monitoredIds: Array.from(monitoredIds), autoBookIds: Array.from(autoBookIds) };
          setSettings(merged);
          saveSettings(merged);
        }}
        resyAuth={resyAuth}
        onResyLogin={handleResyLogin}
        onResyTokenAuth={handleResyTokenAuth}
        onResyLogout={handleResyLogout}
        activeProfile={activeProfileName}
        profiles={profiles}
        onSwitchProfile={handleSwitchProfile}
        onCreateProfile={handleCreateProfile}
        onDeleteProfile={handleDeleteProfile}
      />
    </div>
  );
}
