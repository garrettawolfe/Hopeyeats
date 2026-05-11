"use client";

import { useState, useMemo } from "react";
import type { LogEntry, LogLevel } from "@/lib/logger";
import { formatEntry } from "@/lib/logger";

interface DebugPanelProps {
  entries: LogEntry[];
  onClear: () => void;
  resyAuth: { authenticated: boolean; firstName?: string; lastName?: string; authToken?: string } | null;
  profile: string | null;
  partySize: number;
  monitoredCount: number;
  monitoredNames: string[];
  autoBookNames: string[];
  pollCount: number;
  lastPollTime: string | null;
  isPolling: boolean;
  preferredDays: string[];
  consecutiveFails: number;
}

const ALL_LEVELS: (LogLevel | "all")[] = ["all", "debug", "info", "warn", "error", "success"];
const ALL_MODULES = ["all", "poll", "snipe", "auth", "book", "email", "ui"];

const LEVEL_TEXT: Record<LogLevel, string> = {
  debug: "text-stone-400",
  info: "text-sky-300",
  warn: "text-amber-400",
  error: "text-red-400",
  success: "text-emerald-400",
};

const LEVEL_PILL_ACTIVE: Record<LogLevel | "all", string> = {
  all: "bg-stone-600 text-white",
  debug: "bg-stone-500 text-white",
  info: "bg-sky-700 text-white",
  warn: "bg-amber-700 text-white",
  error: "bg-red-700 text-white",
  success: "bg-emerald-700 text-white",
};

export default function DebugPanel({
  entries,
  onClear,
  resyAuth,
  profile,
  partySize,
  monitoredCount,
  monitoredNames,
  autoBookNames,
  pollCount,
  lastPollTime,
  isPolling,
  preferredDays,
  consecutiveFails,
}: DebugPanelProps) {
  const [levelFilter, setLevelFilter] = useState<LogLevel | "all">("all");
  const [moduleFilter, setModuleFilter] = useState<string>("all");
  const [copied, setCopied] = useState(false);

  const { filtered, errorCount } = useMemo(() => {
    let ec = 0;
    const f: LogEntry[] = [];
    for (const e of entries) {
      if (e.level === "error") ec++;
      if (
        (levelFilter === "all" || e.level === levelFilter) &&
        (moduleFilter === "all" || e.module === moduleFilter)
      ) {
        f.push(e);
      }
    }
    return { filtered: f, errorCount: ec };
  }, [entries, levelFilter, moduleFilter]);

  const lastPollStr = lastPollTime
    ? new Date(lastPollTime).toLocaleTimeString("en-US", { hour12: false })
    : "never";

  const authLine = resyAuth?.authenticated
    ? `✓ Authenticated — ${[resyAuth.firstName, resyAuth.lastName].filter(Boolean).join(" ")}`
    : "✗ Not authenticated";

  const copyForClaude = () => {
    const now = new Date().toLocaleString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/New_York",
    });
    const url = typeof window !== "undefined" ? window.location.href : "unknown";

    const errors = entries.filter((e) => e.level === "error").slice(0, 20);
    const recent = entries.slice(0, 100);
    const dayLabels =
      preferredDays.length > 0
        ? preferredDays.map((d) => d[0].toUpperCase() + d.slice(1, 3)).join(", ")
        : "(all days)";

    const lines: string[] = [
      "# WolfePack Eats — Debug Report",
      `**Time:** ${now} ET`,
      `**URL:** ${url}`,
      "",
      "## Auth & Profile",
      `- Resy: ${authLine}`,
      `- Active profile: ${profile ?? "(none)"}`,
      `- Party size: ${partySize}`,
      "",
      "## Monitoring Status",
      `- Active: ${isPolling ? "YES — scanning" : pollCount > 0 ? "YES" : "IDLE"} — Poll #${pollCount}`,
      `- Last poll: ${lastPollStr}`,
      `- WAF backoff: ${consecutiveFails}x consecutive failures`,
      `- Restaurants monitored: ${monitoredCount} (${monitoredNames.slice(0, 8).join(", ")}${monitoredNames.length > 8 ? ` +${monitoredNames.length - 8} more` : ""})`,
      `- Auto-book (${autoBookNames.length}): ${autoBookNames.join(", ") || "(none)"}`,
      "",
      "## Settings",
      `- Preferred days: ${dayLabels}`,
      "",
      `## Error Log (${errors.length} errors total)`,
      errors.length > 0 ? errors.map((e) => formatEntry(e)).join("\n") : "(no errors)",
      "",
      "## Full Event Log (last 100 entries, newest first)",
      recent.length > 0 ? recent.map((e) => formatEntry(e)).join("\n") : "(no entries yet)",
    ];

    navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const now = new Date().toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  });

  return (
    <div className="bg-stone-900 rounded-xl overflow-hidden border border-stone-700 text-[11px] font-mono">
      {/* System snapshot */}
      <div className="border-b border-stone-700 px-3 py-2 text-stone-300 leading-relaxed space-y-0.5">
        <div className="text-stone-400 text-[10px] mb-1">
          ══ SYSTEM SNAPSHOT — {now} ET ══
        </div>
        <div>
          <span className="text-stone-500">Auth: </span>
          <span className={resyAuth?.authenticated ? "text-emerald-400" : "text-red-400"}>{authLine}</span>
        </div>
        <div>
          <span className="text-stone-500">Profile: </span>
          <span className="text-stone-200">{profile ?? "(none)"}</span>
          <span className="text-stone-500"> | Party: </span>
          <span className="text-stone-200">{partySize}</span>
        </div>
        <div>
          <span className="text-stone-500">Monitoring: </span>
          <span className={isPolling ? "text-amber-400" : "text-stone-200"}>
            {isPolling ? "SCANNING" : pollCount > 0 ? "ACTIVE" : "IDLE"}
          </span>
          <span className="text-stone-500"> — Poll #</span>
          <span className="text-stone-200">{pollCount}</span>
          <span className="text-stone-500">, last </span>
          <span className="text-stone-200">{lastPollStr}</span>
        </div>
        <div>
          <span className="text-stone-500">Restaurants: </span>
          <span className="text-stone-200">{monitoredCount} monitored</span>
          {consecutiveFails > 0 && (
            <span className="text-amber-400"> | WAF backoff {consecutiveFails}x</span>
          )}
        </div>
        {autoBookNames.length > 0 && (
          <div>
            <span className="text-stone-500">Auto-book: </span>
            <span className="text-emerald-400">{autoBookNames.join(", ")}</span>
          </div>
        )}
        {errorCount > 0 && (
          <div>
            <span className="text-red-400">Errors: {errorCount} total in log</span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="border-b border-stone-700 px-3 py-2 flex flex-wrap gap-2 items-center">
        {/* Level filters */}
        <div className="flex gap-1 flex-wrap">
          {ALL_LEVELS.map((lvl) => {
            const isActive = levelFilter === lvl;
            const cnt = lvl === "all" ? entries.length : entries.filter((e) => e.level === lvl).length;
            return (
              <button
                key={lvl}
                onClick={() => setLevelFilter(lvl)}
                className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                  isActive
                    ? LEVEL_PILL_ACTIVE[lvl]
                    : "bg-stone-800 text-stone-400 hover:bg-stone-700"
                }`}
              >
                {lvl.toUpperCase()} {cnt > 0 && `(${cnt})`}
              </button>
            );
          })}
        </div>

        {/* Module filter */}
        <select
          value={moduleFilter}
          onChange={(e) => setModuleFilter(e.target.value)}
          className="text-[10px] bg-stone-800 text-stone-300 border border-stone-700 rounded px-1.5 py-0.5"
        >
          {ALL_MODULES.map((m) => (
            <option key={m} value={m}>
              {m === "all" ? "All Modules" : m}
            </option>
          ))}
        </select>

        <div className="ml-auto flex gap-1.5">
          <button
            onClick={copyForClaude}
            className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
              copied
                ? "bg-emerald-700 text-white"
                : "bg-indigo-700 hover:bg-indigo-600 text-white"
            }`}
          >
            {copied ? "Copied!" : "Copy for Claude"}
          </button>
          <button
            onClick={onClear}
            className="px-2 py-1 bg-stone-800 text-stone-400 hover:bg-red-900 hover:text-red-300 rounded text-[10px] transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Log entries */}
      <div className="max-h-64 overflow-y-auto px-3 py-2 space-y-0.5 select-all">
        {filtered.length === 0 ? (
          <span className="text-stone-500">
            {entries.length === 0 ? "No logs yet — waiting for first poll..." : "No entries match current filters"}
          </span>
        ) : (
          filtered.map((entry, i) => (
            <div key={i} className={LEVEL_TEXT[entry.level] ?? "text-stone-300"}>
              {formatEntry(entry)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
