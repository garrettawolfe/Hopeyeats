import { describe, it, expect } from "vitest";
import { restaurants } from "@/data/restaurants";

const resyRestaurants = restaurants.filter(
  (r) => r.resyUrl !== null && (r.reservationMethod === "resy" || r.reservationMethod === "both"),
);

describe("restaurant data integrity", () => {
  it("has at least 30 restaurants", () => {
    expect(restaurants.length).toBeGreaterThanOrEqual(30);
  });

  it("all IDs are unique", () => {
    const ids = restaurants.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all restaurants have required string fields", () => {
    restaurants.forEach((r) => {
      expect(r.id, `${r.name}: id`).toBeTruthy();
      expect(r.name, `${r.name}: name`).toBeTruthy();
      expect(r.neighborhood, `${r.name}: neighborhood`).toBeTruthy();
      expect(r.cuisine, `${r.name}: cuisine`).toBeTruthy();
    });
  });

  it("all resy restaurants have a resyUrl", () => {
    resyRestaurants.forEach((r) => {
      expect(r.resyUrl, `${r.name}: resyUrl`).toBeTruthy();
      expect(r.resyUrl, `${r.name}: resyUrl format`).toMatch(/^https:\/\/resy\.com/);
    });
  });

  it("resyVenueId is a positive integer or null", () => {
    restaurants.forEach((r) => {
      if (r.resyVenueId !== null) {
        expect(Number.isInteger(r.resyVenueId), `${r.name}: resyVenueId is integer`).toBe(true);
        expect(r.resyVenueId, `${r.name}: resyVenueId > 0`).toBeGreaterThan(0);
      }
    });
  });

  it("advanceDays is a positive integer for all restaurants", () => {
    restaurants.forEach((r) => {
      expect(Number.isInteger(r.advanceDays), `${r.name}: advanceDays integer`).toBe(true);
      expect(r.advanceDays, `${r.name}: advanceDays > 0`).toBeGreaterThan(0);
      expect(r.advanceDays, `${r.name}: advanceDays <= 60`).toBeLessThanOrEqual(60);
    });
  });

  it("bookingTime is null or matches HH:MM AM/PM ET format", () => {
    restaurants.forEach((r) => {
      if (r.bookingTime !== null) {
        expect(r.bookingTime, `${r.name}: bookingTime format`).toMatch(
          /^\d{1,2}:\d{2} (AM|PM) ET$/,
        );
      }
    });
  });

  it("city is one of nyc, miami, hamptons", () => {
    const validCities = new Set(["nyc", "miami", "hamptons"]);
    restaurants.forEach((r) => {
      expect(validCities.has((r as any).city), `${r.name}: city`).toBe(true);
    });
  });

  it("priceRange uses valid values", () => {
    const valid = new Set(["$$", "$$$", "$$$$"]);
    restaurants.forEach((r) => {
      expect(valid.has(r.priceRange), `${r.name}: priceRange`).toBe(true);
    });
  });

  it("category arrays are non-empty and use valid values", () => {
    const valid = new Set(["dinner", "bar", "brunch"]);
    restaurants.forEach((r) => {
      expect((r as any).category?.length, `${r.name}: category non-empty`).toBeGreaterThan(0);
      ((r as any).category as string[]).forEach((c: string) => {
        expect(valid.has(c), `${r.name}: category "${c}"`).toBe(true);
      });
    });
  });

  it("known high-demand restaurants have correct advance days", () => {
    const check = (id: string, days: number) => {
      const r = restaurants.find((x) => x.id === id);
      expect(r, `${id} exists`).toBeDefined();
      expect(r!.advanceDays, `${id}: advanceDays`).toBe(days);
    };
    check("carbone", 30);
    check("lilia", 28);
    check("via-carota", 30);
    check("four-horsemen", 29);
    check("torrisi", 30);
    check("4-charles", 21);
    check("claud", 14);
  });

  it("known restaurants have correct booking times", () => {
    const check = (id: string, time: string | null) => {
      const r = restaurants.find((x) => x.id === id);
      expect(r, `${id} exists`).toBeDefined();
      expect(r!.bookingTime, `${id}: bookingTime`).toBe(time);
    };
    check("raouls", "8:00 AM ET");
    check("four-horsemen", "7:00 AM ET");
    check("lilia", "10:00 AM ET");
    check("carbone", "10:00 AM ET");
    check("claud", "9:00 AM ET");
    check("4-charles", "9:00 AM ET");
  });
});
