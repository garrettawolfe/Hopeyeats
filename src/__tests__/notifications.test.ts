import { describe, it, expect } from "vitest";
import { sendNotifications } from "@/lib/notifications";

describe("sendNotifications", () => {
  it("returns empty sent/failed arrays when no alerts have new slots", async () => {
    const result = await sendNotifications({}, [], "https://example.com");
    expect(result).toEqual({ sent: [], failed: [] });
  });

  it("skips channels that are not enabled", async () => {
    const result = await sendNotifications(
      { ntfy: { enabled: false, topic: "test" } },
      [{ restaurant: { id: "r1", name: "Test", resyVenueId: 1, resyUrl: "", advanceDays: 28 }, newSlots: [{ id: "s1", venueId: 1, venueName: "Test", date: "2026-06-01", time: "19:00", dateTime: "2026-06-01 19:00", tableType: "Indoor", minParty: 2, maxParty: 4, configToken: "tok", resyUrl: "https://resy.com" }] }],
      "https://example.com"
    );
    expect(result.sent).toHaveLength(0);
  });
});
