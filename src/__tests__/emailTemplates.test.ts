import { describe, it, expect, beforeEach, vi } from "vitest";
import { getNearestPreferredDay, buildResyUrl, getBookingContext } from "@/lib/emailTemplates";

describe("getNearestPreferredDay", () => {
  it("returns same date if it already falls on a preferred day", () => {
    // May 9 2026 is a Saturday
    const saturday = new Date("2026-05-09T12:00:00");
    const result = getNearestPreferredDay(saturday, ["saturday"]);
    expect(result.toISOString().split("T")[0]).toBe("2026-05-09");
  });

  it("advances to next preferred day", () => {
    // May 9 2026 is a Saturday — next Sunday is May 10
    const saturday = new Date("2026-05-09T12:00:00");
    const result = getNearestPreferredDay(saturday, ["sunday"]);
    expect(result.toISOString().split("T")[0]).toBe("2026-05-10");
  });

  it("works with multiple preferred days", () => {
    // May 11 2026 is a Monday — next Wed or Thu: Wednesday May 13
    const monday = new Date("2026-05-11T12:00:00");
    const result = getNearestPreferredDay(monday, ["wednesday", "thursday"]);
    expect(result.toISOString().split("T")[0]).toBe("2026-05-13");
  });

  it("returns from date unchanged when preferredDays is empty", () => {
    const date = new Date("2026-05-09T12:00:00");
    const result = getNearestPreferredDay(date, []);
    expect(result.toISOString().split("T")[0]).toBe("2026-05-09");
  });

  it("handles day name case-insensitively", () => {
    const saturday = new Date("2026-05-09T12:00:00");
    const result = getNearestPreferredDay(saturday, ["SATURDAY"]);
    expect(result.toISOString().split("T")[0]).toBe("2026-05-09");
  });
});

describe("buildResyUrl", () => {
  it("appends date and seats query params", () => {
    const saturday = new Date("2026-05-09T12:00:00");
    const url = buildResyUrl("https://resy.com/cities/new-york-ny/venues/lilia", saturday, 2, ["saturday"]);
    expect(url).toBe("https://resy.com/cities/new-york-ny/venues/lilia?date=2026-05-09&seats=2");
  });

  it("snaps date to nearest preferred day", () => {
    // Monday May 11 — snaps to Wednesday May 13 if preferred is wed/thu
    const monday = new Date("2026-05-11T12:00:00");
    const url = buildResyUrl("https://resy.com/cities/ny/venues/test", monday, 4, ["wednesday"]);
    expect(url).toContain("date=2026-05-13");
    expect(url).toContain("seats=4");
  });
});

describe("getBookingContext", () => {
  beforeEach(() => {
    // Fix "today" to May 9 2026 (Friday)
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T10:00:00"));
  });

  it("urgencyTier is 'today' when booking opens today", () => {
    // advanceDays=0, target=today → booking is today
    const ctx = getBookingContext(0, "9:00 AM ET", "");
    expect(ctx.urgencyTier).toBe("today");
    expect(ctx.daysUntilBooking).toBe(0);
  });

  it("urgencyTier is 'soon' when booking opens in 1-6 days", () => {
    // dining date is 3 days from now, advanceDays=3 → booking opens today
    // Actually: advanceDays=14, diningDateStart="" → booking opens in 14 days from target
    // Easier: diningDateStart = today+16, advanceDays=14 → booking opens in 2 days
    const diningDate = new Date("2026-05-09");
    diningDate.setDate(diningDate.getDate() + 16);
    const ctx = getBookingContext(14, null, diningDate.toISOString().split("T")[0]);
    expect(ctx.urgencyTier).toBe("soon");
    expect(ctx.daysUntilBooking).toBe(2);
  });

  it("urgencyTier is 'upcoming' when booking opens 7+ days from now", () => {
    // diningDate = today + 30, advanceDays = 14 → booking opens in 16 days
    const diningDate = new Date("2026-05-09");
    diningDate.setDate(diningDate.getDate() + 30);
    const ctx = getBookingContext(14, "10:00 AM ET", diningDate.toISOString().split("T")[0]);
    expect(ctx.urgencyTier).toBe("upcoming");
    expect(ctx.daysUntilBooking).toBe(16);
    expect(ctx.urgencyLabel).toMatch(/^Book /);
  });

  it("urgencyTier is 'past' when booking window has closed", () => {
    // diningDate was in the past
    const ctx = getBookingContext(14, null, "2026-04-01");
    expect(ctx.urgencyTier).toBe("past");
    expect(ctx.daysUntilBooking).toBeLessThan(0);
    expect(ctx.urgencyLabel).toBe("Window Passed");
    expect(ctx.isActionable).toBe(false);
  });

  it("includes bookingTime in label when booking is today", () => {
    const ctx = getBookingContext(0, "9:00 AM ET", "");
    expect(ctx.urgencyLabel).toContain("9:00 AM ET");
  });

  it("uses 'Today' label when booking is today", () => {
    const ctx = getBookingContext(0, null, "");
    expect(ctx.bookingDateStr).toBe("Today");
  });
});
