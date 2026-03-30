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
  const r = (Math.random() + Math.random() + Math.random()) / 3;
  return Math.max(100, baseMs + (r - 0.5) * 2 * jitter);
}

// ─── Anti-Detection: Rate Limit Tracking ─────────────────────────────────────

interface RateLimitState {
  consecutiveErrors: number;
  backoffUntil: number;
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

function isBackedOff(): boolean {
  return Date.now() < rateLimitState.backoffUntil;
}

function calculateBackoff(): number {
  const base = 60_000;
  const exp = Math.min(rateLimitState.consecutiveErrors, 5);
  const delay = base * Math.pow(2, exp);
  return delay + Math.random() * delay * 0.3;
}

export function getRateLimitStats() {
  return {
    ...rateLimitState,
    isBackedOff: isBackedOff(),
    backoffRemaining: Math.max(0, rateLimitState.backoffUntil - Date.now()),
  };
}

// ─── Core Types ──────────────────────────────────────────────────────────────

export interface ResySlot {
  date: {
    start: string;
    end: string;
  };
  config: {
    id: number;
    token: string;
    type: string;
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
  id: string;
  venueId: number;
  venueName: string;
  date: string;
  time: string;
  dateTime: string;
  tableType: string;
  minParty: number;
  maxParty: number;
  configToken: string;
  resyUrl: string;
}

// ─── Headers ─────────────────────────────────────────────────────────────────

function buildHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Origin: "https://resy.com",
    Referer: "https://resy.com/",
    "User-Agent": randomUserAgent(),
  };

  if (authToken) {
    headers["X-Resy-Auth-Token"] = authToken;
    headers["X-Resy-Universal-Auth"] = authToken;
  }

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
 * Minimal delay version — caller is responsible for rate limiting.
 */
export async function findAvailability(
  venueId: number,
  date: string,
  partySize: number = 2,
  authToken?: string,
): Promise<ResyFindResponse | null> {
  if (isBackedOff()) {
    const waitMs = rateLimitState.backoffUntil - Date.now();
    console.warn(`[Resy] Rate limited — waiting ${Math.round(waitMs / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  // Gap between requests: 500-1000ms to avoid Resy IP blocks
  const timeSinceLast = Date.now() - rateLimitState.lastRequestAt;
  const minGap = 500 + Math.random() * 500;
  if (timeSinceLast < minGap) {
    await new Promise((resolve) => setTimeout(resolve, minGap - timeSinceLast));
  }

  const params = new URLSearchParams({
    venue_id: venueId.toString(),
    day: date,
    party_size: partySize.toString(),
    lat: "40.7128",
    long: "-74.0060",
  });

  const url = `${RESY_API_BASE}/4/find?${params}`;
  rateLimitState.lastRequestAt = Date.now();
  rateLimitState.totalRequests++;

  const response = await fetch(url, {
    method: "GET",
    headers: buildHeaders(authToken),
  });

  // Resy returns 500 for dates with no availability, but track consecutive 500s
  // to detect IP-level blocks (all 500s = blocked, not just "no availability")
  if (response.status === 500) {
    rateLimitState.consecutiveErrors++;
    if (rateLimitState.consecutiveErrors >= 10) {
      const backoff = calculateBackoff();
      rateLimitState.backoffUntil = Date.now() + backoff;
      console.warn(`[Resy] ${rateLimitState.consecutiveErrors} consecutive 500s — likely IP blocked. Backing off ${Math.round(backoff / 1000)}s`);
    }
    return null;
  }

  if (response.status === 429) {
    rateLimitState.total429s++;
    rateLimitState.consecutiveErrors++;
    const backoff = calculateBackoff();
    rateLimitState.backoffUntil = Date.now() + backoff;
    console.warn(`[Resy] 429 Rate Limited — backing off ${Math.round(backoff / 1000)}s`);
    return null;
  }

  if (!response.ok) {
    rateLimitState.consecutiveErrors++;
    return null;
  }

  rateLimitState.consecutiveErrors = 0;
  const data: ResyFindResponse = await response.json();
  return data;
}

/**
 * Resolve a venue URL slug to a numeric venue ID via the Resy API.
 */
export async function resolveVenueId(urlSlug: string): Promise<number | null> {
  if (isBackedOff()) {
    await new Promise((resolve) =>
      setTimeout(resolve, rateLimitState.backoffUntil - Date.now()),
    );
  }

  const params = new URLSearchParams({
    url_slug: urlSlug,
    location_id: "1",
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
 * resyUrl now includes the correct party size and time for deep-linking.
 */
export function parseSlots(
  response: ResyFindResponse,
  venueId: number,
  venueName: string,
  resyBaseUrl: string,
  partySize: number = 2,
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
      resyUrl: `${resyBaseUrl}?date=${datePart}&seats=${partySize}`,
    };
  });
}

// ─── Calendar Endpoint (Two-Phase Optimization) ─────────────────────────────

interface CalendarDay {
  date: string;
  inventory: {
    reservation?: string;
  };
}

interface CalendarResponse {
  scheduled?: CalendarDay[];
  last_calendar_day?: string;
}

/**
 * Fetch the venue calendar to discover which dates have availability.
 * Returns only dates with available inventory.
 */
async function fetchVenueCalendar(
  venueId: number,
  startDate: string,
  endDate: string,
  partySize: number,
  authToken?: string,
): Promise<string[]> {
  if (isBackedOff()) {
    const waitMs = rateLimitState.backoffUntil - Date.now();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const timeSinceLast = Date.now() - rateLimitState.lastRequestAt;
  const minGap = 500 + Math.random() * 500;
  if (timeSinceLast < minGap) {
    await new Promise((resolve) => setTimeout(resolve, minGap - timeSinceLast));
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
      headers: buildHeaders(authToken),
    });

    if (response.status === 429) {
      rateLimitState.total429s++;
      rateLimitState.consecutiveErrors++;
      const backoff = calculateBackoff();
      rateLimitState.backoffUntil = Date.now() + backoff;
      return [];
    }

    if (response.status === 500) {
      rateLimitState.consecutiveErrors++;
      return [];
    }

    if (!response.ok) return [];

    rateLimitState.consecutiveErrors = 0;
    const data: CalendarResponse = await response.json();
    const scheduled = data.scheduled ?? [];

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
 * Two-phase: calendar (1 call) → /4/find only on dates with inventory.
 * Dates are checked in parallel batches of 3 for speed.
 */
export async function checkVenueAvailability(
  venueId: number,
  venueName: string,
  resyBaseUrl: string,
  dates: string[],
  partySize: number = 2,
  authToken?: string,
): Promise<AvailabilitySlot[]> {
  if (dates.length === 0) return [];

  const allSlots: AvailabilitySlot[] = [];
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  // Phase 1: Calendar check (pass auth token)
  let datesToCheck: string[];
  const calendarDates = await fetchVenueCalendar(venueId, startDate, endDate, partySize, authToken);

  if (calendarDates.length > 0) {
    datesToCheck = calendarDates;
  } else {
    // Calendar empty/failed — check fewer dates to stay fast
    datesToCheck = dates.slice(0, Math.min(dates.length, 5));
  }

  // Phase 2: Check dates in parallel batches of 2
  for (let i = 0; i < datesToCheck.length; i += 2) {
    if (rateLimitState.consecutiveErrors >= 8) {
      console.warn(`[Resy] Too many errors (${rateLimitState.consecutiveErrors}), stopping venue ${venueName}`);
      break;
    }

    const batch = datesToCheck.slice(i, i + 2);
    const results = await Promise.all(
      batch.map(async (date) => {
        try {
          const response = await findAvailability(venueId, date, partySize, authToken);
          if (response) {
            rateLimitState.consecutiveErrors = 0; // Reset on success
            return parseSlots(response, venueId, venueName, resyBaseUrl, partySize);
          }
          return [];
        } catch {
          return [];
        }
      }),
    );

    for (const slots of results) {
      allSlots.push(...slots);
    }

    // Delay between batches (500-1000ms)
    if (i + 2 < datesToCheck.length) {
      await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 500));
    }
  }

  return allSlots;
}

// ─── Date Helpers ────────────────────────────────────────────────────────────

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

export function isQuietHours(): boolean {
  const now = new Date();
  const etHour = (now.getUTCHours() - 5 + 24) % 24;
  return etHour >= 2 && etHour < 7;
}

export function getRecommendedInterval(): number {
  const now = new Date();
  const etHour = (now.getUTCHours() - 5 + 24) % 24;

  if (etHour >= 8 && etHour < 10) return 30;
  if (etHour >= 10 || etHour < 1) return 60;
  return 300;
}
