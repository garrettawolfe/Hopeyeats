import { describe, it, expect } from "vitest";
import { formatEntry, makeTs } from "@/lib/logger";
import type { LogEntry } from "@/lib/logger";

describe("makeTs", () => {
  it("returns HH:MM:SS format", () => {
    const ts = makeTs();
    expect(ts).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("uses 24-hour clock", () => {
    const ts = makeTs();
    const hour = parseInt(ts.split(":")[0], 10);
    expect(hour).toBeGreaterThanOrEqual(0);
    expect(hour).toBeLessThanOrEqual(23);
  });
});

describe("formatEntry", () => {
  const base: LogEntry = { ts: "14:32:01", level: "info", module: "poll", msg: "Poll started" };

  it("includes timestamp, padded level, module, and message", () => {
    const out = formatEntry(base);
    expect(out).toBe("[14:32:01] INFO    [poll] Poll started");
  });

  it("pads level tag to exactly 7 chars before the separator space", () => {
    // Format: "[ts] LEVEL   [module] msg" — lvlTag is 7 chars, then a space, then [module]
    const levels = ["debug", "info", "warn", "error", "success"] as const;
    levels.forEach((level) => {
      const out = formatEntry({ ...base, level });
      // Extract the level tag portion: between "] " and " [module]"
      const afterTs = out.slice("[14:32:01] ".length); // "INFO    [poll] Poll started"
      const lvlTag = afterTs.slice(0, 7);
      expect(lvlTag.trimEnd()).toBe(level.toUpperCase());
      expect(lvlTag.length).toBe(7);
    });
  });

  it("appends serialized data when present", () => {
    const out = formatEntry({ ...base, data: { count: 3, restaurant: "Lilia" } });
    expect(out).toContain('| {"count":3,"restaurant":"Lilia"}');
  });

  it("omits data section when not present", () => {
    const out = formatEntry(base);
    expect(out).not.toContain("|");
  });

  it("handles all log levels without throwing", () => {
    const levels = ["debug", "info", "warn", "error", "success"] as const;
    levels.forEach((level) => {
      expect(() => formatEntry({ ...base, level })).not.toThrow();
    });
  });
});
