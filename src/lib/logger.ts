export type LogLevel = "debug" | "info" | "warn" | "error" | "success";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  data?: Record<string, unknown>;
}

export function makeTs(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatEntry(e: LogEntry): string {
  const lvlTag = e.level.toUpperCase().padEnd(7);
  const dataStr = e.data ? ` | ${JSON.stringify(e.data)}` : "";
  return `[${e.ts}] ${lvlTag} [${e.module}] ${e.msg}${dataStr}`;
}
