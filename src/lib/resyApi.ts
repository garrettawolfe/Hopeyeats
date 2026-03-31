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

// ─── Proxy Support ──────────────────────────────────────────────────────────

interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

let proxyList: ProxyConfig[] = [];

/**
 * Set proxy list for rotating through. Format: "host:port:username:password"
 */
export function setProxies(proxies: string[]): void {
  proxyList = proxies.map(p => {
    const parts = p.split(":");
    return {
      host: parts[0],
      port: parseInt(parts[1]),
      username: parts[2],
      password: parts[3],
    };
  });
  console.log(`[Resy] Loaded ${proxyList.length} proxies`);
}

function getRandomProxy(): ProxyConfig | null {
  if (proxyList.length === 0) return null;
  return proxyList[Math.floor(Math.random() * proxyList.length)];
}

/**
 * Build a proxied fetch URL. Note: In serverless environments (Vercel),
 * native fetch doesn't support SOCKS/HTTP proxies directly.
 * This provides the infrastructure for when a proxy agent is available.
 * For Vercel, consider using a proxy service URL instead.
 */
export function getProxyUrl(): string | null {
  const proxy = getRandomProxy();
  if (!proxy) return null;
  const auth = proxy.username ? `${proxy.username}:${proxy.password}@` : "";
  return `http://${auth}${proxy.host}:${proxy.port}`;
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
  pollRequestCount: number; // resets each poll for diagnostic logging
  pollFirst200: boolean; // track if we've seen any 200 this poll
  pollFirst500Body: string | null; // store first 500 body this poll
  pollStatusCounts: Record<number, number>; // count of each HTTP status
  pollErrors: number; // count of fetch exceptions (network errors)
}

const rateLimitState: RateLimitState = {
  consecutiveErrors: 0,
  backoffUntil: 0,
  totalRequests: 0,
  total429s: 0,
  lastRequestAt: 0,
  pollRequestCount: 0,
  pollFirst200: false,
  pollFirst500Body: null,
  pollStatusCounts: {},
  pollErrors: 0,
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

/** Reset consecutive errors at the start of each poll. */
export function resetConsecutiveErrors(): void {
  rateLimitState.consecutiveErrors = 0;
}

/** Reset per-poll diagnostics at the start of each poll cycle. */
export function resetPollDiagnostics(): void {
  rateLimitState.pollRequestCount = 0;
  rateLimitState.pollFirst200 = false;
  rateLimitState.pollFirst500Body = null;
  rateLimitState.pollStatusCounts = {};
  rateLimitState.pollErrors = 0;
}

/** Get poll diagnostic summary for logging. */
export function getPollDiagnostics(): string {
  const statuses = Object.entries(rateLimitState.pollStatusCounts)
    .map(([code, count]) => `${code}:${count}`)
    .join(",");
  return `reqs=${rateLimitState.pollRequestCount}, statuses={${statuses}}, fetchErrors=${rateLimitState.pollErrors}, first500=${rateLimitState.pollFirst500Body ? `"${rateLimitState.pollFirst500Body.slice(0, 150)}"` : "none"}`;
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

  headers["Accept-Encoding"] = "gzip, deflate, br";
  headers["Sec-Fetch-Dest"] = "empty";
  headers["Sec-Fetch-Mode"] = "cors";
  headers["Sec-Fetch-Site"] = "same-site";
  headers["X-Origin"] = "https://resy.com";

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

  // Gap between requests: 200-400ms (fast enough to cover all venues within time budget)
  const timeSinceLast = Date.now() - rateLimitState.lastRequestAt;
  const minGap = 200 + Math.random() * 200;
  if (timeSinceLast < minGap) {
    await new Promise((resolve) => setTimeout(resolve, minGap - timeSinceLast));
  }

  const url = `${RESY_API_BASE}/4/find`;
  const body = JSON.stringify({
    venue_id: venueId,
    day: date,
    party_size: partySize,
    lat: 0,
    long: 0,
  });

  rateLimitState.lastRequestAt = Date.now();
  rateLimitState.totalRequests++;
  rateLimitState.pollRequestCount++;

  const headers = buildHeaders(authToken);
  headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
    });
  } catch (err) {
    rateLimitState.pollErrors++;
    if (rateLimitState.pollErrors <= 3) {
      console.error(`[Resy] Fetch exception venue=${venueId} date=${date}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }

  // Track status codes
  rateLimitState.pollStatusCounts[response.status] = (rateLimitState.pollStatusCounts[response.status] ?? 0) + 1;

  // Log first 2 requests per poll to diagnose issues
  if (rateLimitState.pollRequestCount <= 2) {
    console.log(`[Resy] /4/find ${response.status} venue=${venueId} date=${date}`);
  }

  if (response.status === 500) {
    if (rateLimitState.pollFirst500Body === null) {
      const respBody = await response.text().catch(() => "");
      rateLimitState.pollFirst500Body = respBody.slice(0, 500);
      console.log(`[Resy] First 500 body (venue=${venueId}, date=${date}): "${rateLimitState.pollFirst500Body}"`);
    }
    return null;
  }

  if (response.status === 429) {
    rateLimitState.total429s++;
    rateLimitState.consecutiveErrors++;
    const backoff = calculateBackoff();
    rateLimitState.backoffUntil = Date.now() + backoff;
    console.warn(`[Resy] 429 — backing off ${Math.round(backoff / 1000)}s`);
    return null;
  }

  if (!response.ok) {
    rateLimitState.consecutiveErrors++;
    if (rateLimitState.pollRequestCount <= 3) {
      const text = await response.text().catch(() => "");
      console.log(`[Resy] /4/find ${response.status} venue=${venueId}: ${text.slice(0, 300)}`);
    }
    return null;
  }

  rateLimitState.consecutiveErrors = 0;
  rateLimitState.pollFirst200 = true;
  const data: ResyFindResponse = await response.json();
  const slotCount = data.results?.venues?.[0]?.slots?.length ?? 0;
  if (slotCount > 0 && rateLimitState.pollRequestCount <= 5) {
    console.log(`[Resy] Found ${slotCount} slots venue=${venueId} date=${date}`);
  }
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

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.log(`[Resy] /3/venue ${response.status} for ${urlSlug}: ${body.slice(0, 200)}`);
      return null;
    }

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
      // Log first calendar 500 to diagnose
      if (rateLimitState.totalRequests <= 5) {
        const body = await response.text().catch(() => "");
        console.log(`[Resy] Calendar 500 for venue ${venueId}: ${body.slice(0, 200)}`);
      }
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

  // Skip calendar entirely — it consistently returns 500 with empty body,
  // wasting an API call + delay per restaurant. Just check dates directly.
  const datesToCheck = dates.slice(0, Math.min(dates.length, 3));

  // Phase 2: Check dates in parallel batches of 2
  for (let i = 0; i < datesToCheck.length; i += 2) {
    // Only stop on actual 429 rate limits (not 500s which are normal "no data")
    if (rateLimitState.total429s > 0 && rateLimitState.consecutiveErrors >= 3) {
      console.warn(`[Resy] Rate limited (${rateLimitState.consecutiveErrors} 429 errors), stopping venue ${venueName}`);
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

    // Delay between batches (200-400ms)
    if (i + 2 < datesToCheck.length) {
      await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 200));
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
