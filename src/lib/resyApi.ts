/**
 * Resy API client for checking reservation availability.
 *
 * Uses the unofficial Resy API at api.resy.com.
 * The public API key "youarewhereyoueat" is embedded in the Resy web app
 * and is required for all requests. No user auth token is needed for
 * read-only availability checks.
 */

const RESY_API_BASE = "https://api.resy.com";
const RESY_API_KEY = "youarewhereyoueat";

export interface ResySlot {
  date: {
    start: string; // "2026-04-10 19:00:00"
    end: string;
  };
  config: {
    id: number;
    token: string;
    type: string; // "Dining Room", "Bar", "Patio", etc.
  };
  size: {
    min: number;
    max: number;
  };
  payment?: {
    cancellation_fee?: number;
    deposit_fee?: number;
  };
}

export interface ResyVenueResult {
  venue: {
    id: {
      resy: number;
    };
    name: string;
  };
  slots: ResySlot[];
}

export interface ResyFindResponse {
  results: {
    venues: ResyVenueResult[];
  };
}

export interface ResyVenueSearchResult {
  id: {
    resy: number;
  };
  name: string;
  location: {
    neighborhood: string;
    city: string;
  };
  url_slug: string;
}

export interface AvailabilitySlot {
  id: string; // unique key: venueId-date-time-type
  venueId: number;
  venueName: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  dateTime: string; // full datetime string
  tableType: string;
  minParty: number;
  maxParty: number;
  configToken: string;
  resyUrl: string;
}

function buildHeaders(): Record<string, string> {
  return {
    Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
    "Content-Type": "application/json",
    Origin: "https://resy.com",
    Referer: "https://resy.com/",
  };
}

/**
 * Fetch available reservation slots for a venue on a given date.
 */
export async function findAvailability(
  venueId: number,
  date: string, // YYYY-MM-DD
  partySize: number = 2,
): Promise<ResyFindResponse | null> {
  const params = new URLSearchParams({
    venue_id: venueId.toString(),
    day: date,
    party_size: partySize.toString(),
    lat: "40.7128",
    long: "-73.9060",
  });

  const url = `${RESY_API_BASE}/4/find?${params}`;

  const response = await fetch(url, {
    method: "GET",
    headers: buildHeaders(),
  });

  if (!response.ok) {
    console.error(
      `Resy API error for venue ${venueId}: ${response.status} ${response.statusText}`,
    );
    return null;
  }

  return response.json();
}

/**
 * Parse raw Resy API response into normalized AvailabilitySlot objects.
 */
export function parseSlots(
  response: ResyFindResponse,
  venueId: number,
  venueName: string,
  resyBaseUrl: string,
): AvailabilitySlot[] {
  const venues = response.results?.venues ?? [];
  if (venues.length === 0) return [];

  const venue = venues[0];
  const slots = venue.slots ?? [];

  return slots.map((slot) => {
    const dateTime = slot.date?.start ?? "";
    const [datePart, timePart] = dateTime.split(" ");
    const time = timePart ? timePart.substring(0, 5) : "";
    const tableType = slot.config?.type ?? "Unknown";

    return {
      id: `${venueId}-${datePart}-${time}-${tableType}`,
      venueId,
      venueName,
      date: datePart,
      time,
      dateTime,
      tableType,
      minParty: slot.size?.min ?? 1,
      maxParty: slot.size?.max ?? 2,
      configToken: slot.config?.token ?? "",
      resyUrl: `${resyBaseUrl}?date=${datePart}&seats=${slot.size?.min ?? 2}`,
    };
  });
}

/**
 * Check availability for a venue across a range of future dates.
 * Returns all found slots.
 */
export async function checkVenueAvailability(
  venueId: number,
  venueName: string,
  resyBaseUrl: string,
  dates: string[],
  partySize: number = 2,
): Promise<AvailabilitySlot[]> {
  const allSlots: AvailabilitySlot[] = [];

  // Query each date sequentially to avoid rate limiting
  for (const date of dates) {
    try {
      const response = await findAvailability(venueId, date, partySize);
      if (response) {
        const slots = parseSlots(response, venueId, venueName, resyBaseUrl);
        allSlots.push(...slots);
      }
    } catch (err) {
      console.error(
        `Error checking ${venueName} on ${date}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Small delay between requests to be respectful
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return allSlots;
}

/**
 * Generate an array of date strings (YYYY-MM-DD) from today forward.
 */
export function getForwardDates(daysAhead: number): string[] {
  const dates: string[] = [];
  const today = new Date();

  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(d.toISOString().split("T")[0]);
  }

  return dates;
}
