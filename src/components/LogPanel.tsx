"use client";

import { useState, useRef, useEffect } from "react";

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error" | "success" | "debug";
  msg: string;
}

function levelColor(level: LogEntry["level"]) {
  switch (level) {
    case "error": return "text-red-400";
    case "warn": return "text-amber-400";
    case "success": return "text-emerald-400";
    case "debug": return "text-stone-500";
    default: return "text-stone-300";
  }
}

function levelTag(level: LogEntry["level"]) {
  switch (level) {
    case "error": return "ERR ";
    case "warn": return "WARN";
    case "success": return "OK  ";
    case "debug": return "DBG ";
    default: return "INFO";
  }
}

interface Props {
  entries: LogEntry[];
  title?: string;
  defaultOpen?: boolean;
}

export default function LogPanel({ entries, title = "Logs", defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [entries, open]);

  const copyText = entries
    .map((e) => `[${e.ts}] ${levelTag(e.level)} ${e.msg}`)
    .join("\n");

  function handleCopy() {
    navigator.clipboard.writeText(copyText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const errorCount = entries.filter((e) => e.level === "error").length;
  const warnCount = entries.filter((e) => e.level === "warn").length;

  return (
    <div className="bg-charcoal rounded-xl overflow-hidden border border-stone-700">
      {/* Header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-stone-800 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-stone-300 text-sm font-medium">{title}</span>
          <span className="text-stone-500 text-xs">({entries.length})</span>
          {errorCount > 0 && (
            <span className="text-xs text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded">
              {errorCount} error{errorCount !== 1 ? "s" : ""}
            </span>
          )}
          {warnCount > 0 && errorCount === 0 && (
            <span className="text-xs text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">
              {warnCount} warn{warnCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {entries.length > 0 && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); handleCopy(); }}
              onKeyDown={(e) => e.key === "Enter" && handleCopy()}
              className="text-xs text-stone-400 hover:text-white px-2 py-0.5 rounded border border-stone-600 hover:border-stone-400 transition-colors"
            >
              {copied ? "Copied!" : "Copy"}
            </span>
          )}
          <svg
            className={`w-4 h-4 text-stone-500 transition-transform ${open ? "rotate-180" : ""}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {open && (
        <div className="border-t border-stone-700 max-h-64 overflow-y-auto font-mono text-xs px-3 py-2 space-y-0.5 bg-stone-900">
          {entries.length === 0 ? (
            <p className="text-stone-600 py-2">No log entries yet.</p>
          ) : (
            entries.map((e, i) => (
              <div key={i} className="flex gap-2 items-start">
                <span className="text-stone-600 shrink-0">{e.ts}</span>
                <span className={`shrink-0 ${levelColor(e.level)}`}>{levelTag(e.level)}</span>
                <span className="text-stone-300 break-all">{e.msg}</span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
