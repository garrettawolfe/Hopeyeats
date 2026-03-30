/**
 * Resy API client for checking reservation availability.
 *
 * Uses the unofficial Resy API at api.resy.com with anti-detection measures:
 * - Randomized request delays with jitter
 * - Rotating User-Agent strings
 * - Exponential backoff on rate limits (429)
 * - Request fingerprint randomization
 * - Sleep window awareness (reduced polling overnight)
 * - Per-request header variation
 */

const RESY_API_BASE = "https://api.resy.com";

// The production API key embedded in Resy's frontend JS bundle.
// Two known keys — VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5 is the more current one.
const RESY_API_KEY = "VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5";

// ─── Anti-Detection: User-Agent Rotation ─────────────────────────────────────

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:134.0) Gecko/20100101 Firefox/134.0",
];

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── Anti-Detection: Randomized Delays ───────────────────────────────────────

/** Random delay between min and max milliseconds (uniform distribution). */
function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/** Add gaussian-like jitter to a base delay. Returns ms. */
function jitteredDelay(baseMs: number, jitterPercent: number = 0.3): number {
  const jitter = baseMs * jitterPercent;
  // Box-Muller approximation: sum of randoms approaches normal
  const r = (Math.random() + Math.random() + Math.random()) / 3;
  return Math.max(100, baseMs + (r - 0.5) * 2 * jitter);
}

// ─── Anti-Detection: Rate Limit Tracking ─────────────────────────────────────

interface RateLimitState {
  consecutiveErrors: number;
  backoffUntil: number; // timestamp ms
  totalRequests: number;
  total429s: number;
  lastRequestAt: number;
}

const rateLimitState: RateLimitState = {
  consecutiveErrors: 0,
  backoffUntil: 0,
  totalRequests: 0,
  total429s: 0,
  lastRequestAt: 0,
};

/** Check if we're currently in a backoff period. */
function isBackedOff(): boolean {
  return Date.now() < rateLimitState.backoffUntil;
}

/** Calculate exponential backoff delay after a 429. */
function calculateBackoff(): number {
  const base = 60_000; // 60 seconds base
  const exp = Math.min(rateLimitState.consecutiveErrors, 5);
  const delay = base * Math.pow(2, exp);
  // Add 0-30% jitter
  return delay + Math.random() * delay * 0.3;
}

/** Get current rate limit stats for monitoring UI. */
export function getRateLimitStats() {
  return {
    ...rateLimitState,
    isBackedOff: isBackedOff(),
    backoffRemaining: Math.max(0, rateLimitState.backoffUntil - Date.now()),
  };
}

// ─── Anti-Detection: Request Fingerprint Variation ───────────────────────────

/** Slightly vary lat/long to avoid identical request fingerprints. */
function randomizedCoords(): { lat: string; long: string } {
  // NYC area: ~40.71 to 40.78, ~-74.01 to -73.93
  const lat = 40.71 + Math.random() * 0.07;
  const long = -74.01 + Math.random() * 0.08;
  return {
    lat: lat.toFixed(4),
    long: long.toFixed(4),
  };
}

// ─── Core Types ──────────────────────────────────────────────────────────────

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

// ─── Headers ─────────────────────────────────────────────────────────────────

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Origin: "https://resy.com",
    Referer: "https://resy.com/",
    "User-Agent": randomUserAgent(),
  };

  // Randomly include optional headers to vary fingerprint
  if (Math.random() > 0.5) {
    headers["Accept-Encoding"] = "gzip, deflate, br";
  }
  if (Math.random() > 0.7) {
    headers["Sec-Fetch-Dest"] = "empty";
    headers["Sec-Fetch-Mode"] = "cors";
    headers["Sec-Fetch-Site"] = "same-site";
  }

  return headers;
}

// ─── API Methods ─────────────────────────────────────────────────────────────

/**
 * Fetch available reservation slots for a venue on a given date.
 * Includes rate limit handling and exponential backoff.
 */
export async function findAvailability(
  venueId: number,
  date: string,
  partySize: number = 2,
): Promise<ResyFindResponse | null> {
  // Respect backoff period
  if (isBackedOff()) {
    const waitMs = rateLimitState.backoffUntil - Date.now();
    console.warn(
      `[Resy] Rate limited — waiting ${Math.round(waitMs / 1000)}s before retry`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  // Enforce minimum gap between requests (800-2000ms randomized)
  const timeSinceLast = Date.now() - rateLimitState.lastRequestAt;
  const minGap = 800 + Math.random() * 1200;
  if (timeSinceLast < minGap) {
    await new Promise((resolve) =>
      setTimeout(resolve, minGap - timeSinceLast),
    );
  }

  // Don't send lat/long — randomized coords cause 400/500 errors from Resy
  const params = new URLSearchParams({
    venue_id: venueId.toString(),
    day: date,
    party_size: partySize.toString(),
  });

  const url = `${RESY_API_BASE}/4/find?${params}`;
  rateLimitState.lastRequestAt = Date.now();
  rateLimitState.totalRequests++;

  let response = await fetch(url, {
    method: "GET",
    headers: buildHeaders(),
  });

  // Retry once on 500 (server error) with a brief delay
  if (response.status === 500) {
    await randomDelay(300, 800);
    rateLimitState.totalRequests++;
    response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(),
    });
  }

  // Handle rate limiting with exponential backoff
  if (response.status === 429) {
    rateLimitState.total429s++;
    rateLimitState.consecutiveErrors++;
    const backoff = calculateBackoff();
    rateLimitState.backoffUntil = Date.now() + backoff;
    console.warn(
      `[Resy] 429 Rate Limited (attempt ${rateLimitState.consecutiveErrors}) — backing off ${Math.round(backoff / 1000)}s`,
    );
    return null;
  }

  // Handle other errors
  if (!response.ok) {
    rateLimitState.consecutiveErrors++;
    const body = await response.text().catch(() => "");
    console.error(
      `[Resy] ${response.status} for venue ${venueId} on ${date}: ${body.slice(0, 200)}`,
    );
    return null;
  }

  // Success — reset consecutive error count
  rateLimitState.consecutiveErrors = 0;

  return response.json();
}

/**
 * Resolve a venue URL slug to a numeric venue ID via the Resy API.
 * e.g., "don-angie" → 1505
 */
export async function resolveVenueId(
  urlSlug: string,
): Promise<number | null> {
  if (isBackedOff()) {
    await new Promise((resolve) =>
      setTimeout(resolve, rateLimitState.backoffUntil - Date.now()),
    );
  }

  const params = new URLSearchParams({
    url_slug: urlSlug,
    location_id: "1", // NYC
  });

  const url = `${RESY_API_BASE}/3/venue?${params}`;
  rateLimitState.lastRequestAt = Date.now();
  rateLimitState.totalRequests++;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(),
    });

    if (!response.ok) return null;

    const data = await response.json();
    return data?.id?.resy ?? null;
  } catch {
    return null;
  }
}

// ─── Slot Parsing ────────────────────────────────────────────────────────────

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

// ─── Calendar Endpoint (Two-Phase Optimization) ─────────────────────────────

interface CalendarDay {
  date: string;
  inventory: {
    reservation?: string; // "available" | "sold-out" | null
  };
}

interface CalendarResponse {
  scheduled?: CalendarDay[];
  last_calendar_day?: string;
}

/**
 * Fetch the venue calendar to discover which dates have availability.
 * Uses the /4/venue/calendar endpoint (undocumented but used by Resy web app).
 * Returns only dates with available inventory, drastically reducing /4/find calls.
 */
async function fetchVenueCalendar(
  venueId: number,
  startDate: string,
  endDate: string,
  partySize: number,
): Promise<string[]> {
  if (isBackedOff()) {
    const waitMs = rateLimitState.backoffUntil - Date.now();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const timeSinceLast = Date.now() - rateLimitState.lastRequestAt;
  const minGap = 800 + Math.random() * 1200;
  if (timeSinceLast < minGap) {
    await new Promise((resolve) =>
      setTimeout(resolve, minGap - timeSinceLast),
    );
  }

  const params = new URLSearchParams({
    venue_id: venueId.toString(),
    num_seats: partySize.toString(),
    start_date: startDate,
    end_date: endDate,
  });

  const url = `${RESY_API_BASE}/4/venue/calendar?${params}`;
  rateLimitState.lastRequestAt = Date.now();
  rateLimitState.totalRequests++;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(),
    });

    if (response.status === 429) {
      rateLimitState.total429s++;
      rateLimitState.consecutiveErrors++;
      const backoff = calculateBackoff();
      rateLimitState.backoffUntil = Date.now() + backoff;
      return [];
    }

    if (!response.ok) {
      // Calendar endpoint may not exist for all venues — fall back gracefully
      return [];
    }

    rateLimitState.consecutiveErrors = 0;
    const data: CalendarResponse = await response.json();
    const scheduled = data.scheduled ?? [];

    // Return only dates with available inventory
    return scheduled
      .filter((day) => day.inventory?.reservation === "available")
      .map((day) => day.date);
  } catch {
    return [];
  }
}

// ─── Venue Availability Check ────────────────────────────────────────────────

/**
 * Check availability for a venue across a range of future dates.
 *
 * Two-phase approach (inspired by korbinschulz/resybot-open):
 * 1. Hit /4/venue/calendar to get which dates have inventory (1 API call)
 * 2. Hit /4/find only on dates with availability (N calls, where N << total dates)
 *
 * Falls back to checking all dates if the calendar endpoint fails.
 */
export async function checkVenueAvailability(
  venueId: number,
  venueName: string,
  resyBaseUrl: string,
  dates: string[],
  partySize: number = 2,
): Promise<AvailabilitySlot[]> {
  if (dates.length === 0) return [];

  // Reset consecutive error counter for each restaurant so failures
  // on one venue don't cascade and abort checks for the next venue.
  rateLimitState.consecutiveErrors = 0;

  const allSlots: AvailabilitySlot[] = [];
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  // Phase 1: Calendar check (single request to find which dates have inventory)
  let datesToCheck: string[];
  const calendarDates = await fetchVenueCalendar(
    venueId,
    startDate,
    endDate,
    partySize,
  );

  if (calendarDates.length > 0) {
    // Calendar worked — only check dates with availability
    datesToCheck = calendarDates;
    console.log(
      `[Resy] ${venueName}: calendar found ${calendarDates.length}/${dates.length} dates with inventory`,
    );
  } else {
    // Calendar failed or returned empty — fall back to checking all dates
    // but cap at 10 to avoid excessive requests
    datesToCheck = dates.slice(0, Math.min(dates.length, 10));
  }

  // Phase 2: Get detailed slots for available dates
  // Shuffle to avoid predictable sequential patterns
  const shuffledDates = [...datesToCheck].sort(() => Math.random() - 0.5);

  for (const date of shuffledDates) {
    if (rateLimitState.consecutiveErrors >= 3) {
      console.warn(
        `[Resy] Too many consecutive errors for ${venueName} — aborting remaining dates`,
      );
      break;
    }

    try {
      const response = await findAvailability(venueId, date, partySize);
      if (response) {
        const slots = parseSlots(response, venueId, venueName, resyBaseUrl);
        allSlots.push(...slots);
      }
    } catch (err) {
      console.error(
        `[Resy] Error checking ${venueName} on ${date}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Randomized delay between date queries (1-3s with jitter)
    await new Promise((resolve) =>
      setTimeout(resolve, jitteredDelay(1500, 0.4)),
    );
  }

  return allSlots;
}

// ─── Date Helpers ────────────────────────────────────────────────────────────

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

/**
 * Check if current time is in the "quiet hours" window (2-7 AM ET).
 * During quiet hours, polling should be reduced or paused.
 */
export function isQuietHours(): boolean {
  const now = new Date();
  // Convert to ET (approximate — doesn't handle DST perfectly)
  const etHour = (now.getUTCHours() - 5 + 24) % 24;
  return etHour >= 2 && etHour < 7;
}

/**
 * Get recommended poll interval based on time of day.
 * Higher frequency during peak booking hours, lower overnight.
 */
export function getRecommendedInterval(): number {
  const now = new Date();
  const etHour = (now.getUTCHours() - 5 + 24) % 24;

  // Peak booking hours: 8-10 AM ET (when most restaurants release)
  if (etHour >= 8 && etHour < 10) return 30;
  // Active hours: 10 AM - midnight ET
  if (etHour >= 10 || etHour < 1) return 60;
  // Quiet hours: 1-8 AM ET
  return 300;
}
