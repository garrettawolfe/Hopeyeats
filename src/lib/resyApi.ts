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

// ─── Anti-Detection: Fingerprint Rotation (#1 Sec-CH-UA, #2 Accept-Language, #3 Referer) ─

// Each "persona" is a coherent set of UA + Sec-CH-UA + Accept-Language + Referer
// so headers don't contradict each other within a single request.
interface BrowserPersona {
  userAgent: string;
  secChUa: string;          // #1: Sec-CH-UA header (Chrome 90+ sends this)
  secChUaMobile: string;
  secChUaPlatform: string;
  acceptLanguage: string;   // #2: Rotated per-persona
}

const PERSONAS: BrowserPersona[] = [
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaMobile: "?0",
    secChUaPlatform: '"macOS"',
    acceptLanguage: "en-US,en;q=0.9",
  },
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaMobile: "?0",
    secChUaPlatform: '"Windows"',
    acceptLanguage: "en-US,en;q=0.9,es;q=0.8",
  },
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="130", "Chromium";v="130", "Not_A Brand";v="24"',
    secChUaMobile: "?0",
    secChUaPlatform: '"macOS"',
    acceptLanguage: "en,en-US;q=0.9",
  },
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    secChUa: '"Microsoft Edge";v="130", "Chromium";v="130", "Not_A Brand";v="24"',
    secChUaMobile: "?0",
    secChUaPlatform: '"Windows"',
    acceptLanguage: "en-US,en;q=0.9,fr;q=0.8",
  },
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    secChUa: "",  // Safari doesn't send Sec-CH-UA
    secChUaMobile: "",
    secChUaPlatform: "",
    acceptLanguage: "en-US,en;q=0.9",
  },
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
    secChUa: "",  // Firefox doesn't send Sec-CH-UA
    secChUaMobile: "",
    secChUaPlatform: "",
    acceptLanguage: "en-US,en;q=0.5",
  },
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:134.0) Gecko/20100101 Firefox/134.0",
    secChUa: "",
    secChUaMobile: "",
    secChUaPlatform: "",
    acceptLanguage: "en-GB,en;q=0.8,en-US;q=0.6",
  },
  {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaMobile: "?0",
    secChUaPlatform: '"Linux"',
    acceptLanguage: "en-US,en;q=0.9",
  },
];

// #3: Referer rotation — real users arrive from different pages
const REFERERS = [
  "https://resy.com/",
  "https://resy.com/cities/ny",
  "https://resy.com/cities/ny/find",
  "https://resy.com/cities/mia",
  "https://www.google.com/",
];

// Pick a persona per poll cycle (consistent within a poll, varies between polls)
let currentPersona: BrowserPersona = PERSONAS[0];

function rotatePersona(): void {
  currentPersona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
}

function randomReferer(): string {
  return REFERERS[Math.floor(Math.random() * REFERERS.length)];
}

function randomUserAgent(): string {
  return currentPersona.userAgent;
}

// ─── Cookie Jar (Imperva WAF) ──────────────────────────────────────────────
// Imperva/Incapsula sets cookies (visid_incap, nlbi, incap_ses) on first request.
// Subsequent requests MUST include these cookies or get blocked with 500.

const cookieJar: Map<string, string> = new Map();

/** Extract set-cookie headers and store them. */
function captureResponseCookies(response: Response): void {
  // response.headers.getSetCookie() returns all Set-Cookie headers
  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const raw of setCookies) {
    const nameValue = raw.split(";")[0]; // "name=value"
    const eqIdx = nameValue.indexOf("=");
    if (eqIdx > 0) {
      const name = nameValue.substring(0, eqIdx).trim();
      const value = nameValue.substring(eqIdx + 1).trim();
      cookieJar.set(name, value);
    }
  }
  // Fallback: try raw header (some runtimes combine them)
  if (setCookies.length === 0) {
    const combined = response.headers.get("set-cookie");
    if (combined) {
      for (const part of combined.split(/,(?=[^ ])/)) {
        const nameValue = part.split(";")[0].trim();
        const eqIdx = nameValue.indexOf("=");
        if (eqIdx > 0) {
          const name = nameValue.substring(0, eqIdx).trim();
          const value = nameValue.substring(eqIdx + 1).trim();
          cookieJar.set(name, value);
        }
      }
    }
  }
}

/** Build Cookie header string from stored cookies. */
export function getCookieHeader(): string | null {
  if (cookieJar.size === 0) return null;
  return Array.from(cookieJar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/** Export the current cookie jar as a plain object (for Redis persistence). */
export function exportCookies(): Record<string, string> {
  return Object.fromEntries(cookieJar.entries());
}

/**
 * Import cookies from the pre-warm Redis cache and mark them as trusted.
 * Calling this before warmUpImperva() prevents the warmup from discarding them.
 */
export function importCookiesFromPrewarm(cookies: Record<string, string>): void {
  cookieJar.clear();
  for (const [name, value] of Object.entries(cookies)) {
    cookieJar.set(name, value);
  }
  // Tell warmUpImperva() these cookies are known-good — skip re-warming
  lastPollHadSuccess = true;
  lastWarmUpAt = Date.now();
  const names = Object.keys(cookies).join(", ");
  console.log(`[Resy] Loaded ${Object.keys(cookies).length} cookies from pre-warm cache: [${names}]`);
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
  const cookieNames = Array.from(cookieJar.keys()).join(",");
  return `reqs=${rateLimitState.pollRequestCount}, statuses={${statuses}}, fetchErrors=${rateLimitState.pollErrors}, cookies=[${cookieNames}]`;
}

// ─── Imperva Warm-Up ──────────────────────────────────────────────────────────
// Fetch resy.com homepage to acquire fresh Imperva cookies before API calls.
// This helps bypass IP-reputation based blocks on datacenter IPs.

let lastWarmUpAt = 0;
const WARMUP_COOLDOWN_MS = 60_000; // Don't re-warm more than once per 60s
let lastPollHadSuccess = false; // Track if last poll had any 200s
let consecutiveWarmUpFailures = 0; // Track when re-warming is futile (IP blocked)

/** Called by monitor route to signal that the last poll had successful API calls. */
export function markPollSuccess(had200s: boolean): void {
  lastPollHadSuccess = had200s;
  if (had200s) {
    consecutiveWarmUpFailures = 0;
  } else {
    consecutiveWarmUpFailures++;
  }
}

/** #5: Check if cookie jar has the required Imperva cookies for API access. */
export function hasValidCookies(): boolean {
  const names = Array.from(cookieJar.keys());
  const hasVisid = names.some(n => n.startsWith("visid_incap_"));
  const hasNlbi = names.some(n => n.startsWith("nlbi_"));
  return hasVisid && hasNlbi;
}

export async function warmUpImperva(): Promise<void> {
  const now = Date.now();

  // CRITICAL: Don't re-warm if cookies are working.
  // Re-warming clears the cookie jar, and new cookies often don't work.
  if (hasValidCookies()) {
    if (lastPollHadSuccess) {
      // Cookies worked last poll — keep them, don't touch
      return;
    }
    // After 3+ consecutive failures, re-warming is futile — IP is blocked.
    // Only re-warm every 60s to avoid wasting requests.
    if (consecutiveWarmUpFailures >= 3 && now - lastWarmUpAt < WARMUP_COOLDOWN_MS) {
      return;
    }
    if (now - lastWarmUpAt < 5_000) {
      return; // Don't re-warm within 5s of last warm-up
    }
    console.log(`[Resy] Warm-up triggered: cookies exist but last poll was all 500s — force refresh (fail streak: ${consecutiveWarmUpFailures})`);
  } else if (now - lastWarmUpAt < 10_000) {
    // Just warmed up <10s ago and still no valid cookies — don't spam
    return;
  }

  // Clear stale cookies — mixing cookies from different Imperva sessions causes 500s
  cookieJar.clear();

  // Rotate browser persona for this poll cycle (#1/#2/#3 attribution)
  rotatePersona();
  const persona = currentPersona;

  const commonHeaders: Record<string, string> = {
    "User-Agent": persona.userAgent,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": persona.acceptLanguage,
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
  // Add Sec-CH-UA for Chrome/Edge personas
  if (persona.secChUa) {
    commonHeaders["Sec-CH-UA"] = persona.secChUa;
    commonHeaders["Sec-CH-UA-Mobile"] = persona.secChUaMobile;
    commonHeaders["Sec-CH-UA-Platform"] = persona.secChUaPlatform;
  }

  try {
    // Step 1: Hit resy.com to get Imperva cookies for the main domain
    const r1 = await fetch("https://resy.com", {
      method: "GET",
      headers: commonHeaders,
      redirect: "follow",
    });
    captureResponseCookies(r1);

    // Step 2: Hit api.resy.com to get Imperva cookies for the API domain
    // (may use a different Imperva site ID)
    const cookiesSoFar = getCookieHeader();
    const r2 = await fetch("https://api.resy.com/3/venue?url_slug=lartusi&location_id=1", {
      method: "GET",
      headers: {
        ...commonHeaders,
        Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
        Accept: "application/json",
        Origin: "https://resy.com",
        Referer: "https://resy.com/",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        ...(cookiesSoFar ? { Cookie: cookiesSoFar } : {}),
      },
    });
    captureResponseCookies(r2);

    lastWarmUpAt = now;

    // #11: Validate warm-up cookies — log what we got and whether it's sufficient
    const cookieNames = Array.from(cookieJar.keys()).join(", ");
    const valid = hasValidCookies();
    console.log(`[Resy] Warm-up resy=${r1.status} api=${r2.status} valid=${valid} persona=${persona.userAgent.includes("Chrome") ? "Chrome" : persona.userAgent.includes("Firefox") ? "Firefox" : persona.userAgent.includes("Safari") ? "Safari" : "Edge"} cookies=[${cookieNames}]`);
    if (!valid) {
      console.warn(`[Resy] Warm-up INCOMPLETE — missing required Imperva cookies (need visid_incap + nlbi). Got: [${cookieNames}]`);
    }
  } catch (err) {
    // Even if warm-up partially fails, keep whatever cookies we got
    lastWarmUpAt = now;
    const cookieNames = Array.from(cookieJar.keys()).join(", ");
    console.warn(`[Resy] Warm-up FAILED: ${err instanceof Error ? err.message : String(err)} — cookies so far: [${cookieNames}]`);
  }
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
    is_visible?: boolean;
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
  const persona = currentPersona;
  const referer = randomReferer(); // #3: Varied referer

  const headers: Record<string, string> = {
    Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": persona.acceptLanguage,  // #2: Rotated per-persona
    "Cache-Control": "no-cache",
    Origin: "https://resy.com",
    Referer: referer,
    "User-Agent": persona.userAgent,
  };

  // #1: Sec-CH-UA headers (Chrome/Edge only — Safari/Firefox don't send them)
  if (persona.secChUa) {
    headers["Sec-CH-UA"] = persona.secChUa;
    headers["Sec-CH-UA-Mobile"] = persona.secChUaMobile;
    headers["Sec-CH-UA-Platform"] = persona.secChUaPlatform;
  }

  if (authToken) {
    headers["X-Resy-Auth-Token"] = authToken;
    headers["X-Resy-Universal-Auth"] = authToken;
  }

  headers["Accept-Encoding"] = "gzip, deflate, br";
  headers["Sec-Fetch-Dest"] = "empty";
  headers["Sec-Fetch-Mode"] = "cors";
  headers["Sec-Fetch-Site"] = "same-site";
  headers["X-Origin"] = "https://resy.com";

  // Include Imperva WAF cookies if we have them
  const cookies = getCookieHeader();
  if (cookies) {
    headers["Cookie"] = cookies;
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
  venueName?: string,
): Promise<ResyFindResponse | null> {
  if (isBackedOff()) {
    const waitMs = rateLimitState.backoffUntil - Date.now();
    console.warn(`[Resy] Rate limited — waiting ${Math.round(waitMs / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  // #4: Gaussian-like jitter (150-800ms) instead of uniform 200-400ms — more human-like
  const timeSinceLast = Date.now() - rateLimitState.lastRequestAt;
  const r = (Math.random() + Math.random() + Math.random()) / 3; // ~gaussian centered at 0.5
  const minGap = 150 + r * 650; // 150-800ms with center ~475ms
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

  // Capture Imperva cookies from every response
  captureResponseCookies(response);

  // Track status codes
  rateLimitState.pollStatusCounts[response.status] = (rateLimitState.pollStatusCounts[response.status] ?? 0) + 1;

  const venueLabel = venueName ? `${venueId} (${venueName})` : String(venueId);

  // Log first 2 requests per poll to diagnose issues
  if (rateLimitState.pollRequestCount <= 2) {
    console.log(`[Resy] /4/find ${response.status} venue=${venueLabel} date=${date}`);
  }

  if (response.status === 500) {
    if (rateLimitState.pollFirst500Body === null) {
      const respBody = await response.text().catch(() => "");
      rateLimitState.pollFirst500Body = respBody.slice(0, 500);
      const bodyNote = rateLimitState.pollFirst500Body ? `body="${rateLimitState.pollFirst500Body}"` : "empty body — WAF block";
      console.log(`[Resy] First 500 venue=${venueLabel} date=${date}: ${bodyNote}`);
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
    // Log raw structure of first slot once per session to capture unknown fields
    // (helps identify Crown/access-restricted slots we're not parsing yet)
    if (rateLimitState.pollRequestCount === 1) {
      const rawSlot = (data as unknown as { results: { venues: { slots: unknown[] }[] } })
        .results?.venues?.[0]?.slots?.[0];
      if (rawSlot) {
        console.log(`[Resy] Raw slot[0] venue=${venueId}: ${JSON.stringify(rawSlot)}`);
      }
    }
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

  // Filter out invisible slots — these are Crown/exclusive-gated reservations
  // that the server exposes in the response but marks as not publicly bookable.
  const visibleSlots = slots.filter((slot) => slot.config?.is_visible !== false);
  const hiddenCount = slots.length - visibleSlots.length;
  if (hiddenCount > 0) {
    console.log(`[Resy] ${venueName}: ${hiddenCount} Crown/exclusive slot(s) hidden (is_visible=false), ${visibleSlots.length} public slot(s) remain`);
  }

  return visibleSlots.map((slot) => {
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
  maxDates: number = 3,
): Promise<AvailabilitySlot[]> {
  if (dates.length === 0) return [];

  const venueStart = Date.now(); // #9: Per-restaurant timing
  const allSlots: AvailabilitySlot[] = [];

  const datesToCheck = dates.slice(0, Math.min(dates.length, maxDates));

  for (let i = 0; i < datesToCheck.length; i += 2) {
    if (rateLimitState.total429s > 0 && rateLimitState.consecutiveErrors >= 3) {
      console.warn(`[Resy] Rate limited (${rateLimitState.consecutiveErrors} 429 errors), stopping venue ${venueName}`);
      break;
    }

    const batch = datesToCheck.slice(i, i + 2);
    const results = await Promise.all(
      batch.map(async (date) => {
        try {
          const response = await findAvailability(venueId, date, partySize, authToken, venueName);
          if (response) {
            rateLimitState.consecutiveErrors = 0;
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

    // #4: Gaussian-like inter-batch jitter (150-600ms)
    if (i + 2 < datesToCheck.length) {
      const r = (Math.random() + Math.random() + Math.random()) / 3;
      await new Promise((resolve) => setTimeout(resolve, 150 + r * 450));
    }
  }

  // #9: Log per-restaurant timing (only for restaurants that found slots or took >2s)
  const venueMs = Date.now() - venueStart;
  if (allSlots.length > 0 || venueMs > 2000) {
    console.log(`[Resy] ${venueName}: ${allSlots.length} slots in ${(venueMs / 1000).toFixed(1)}s (${datesToCheck.length} dates)`);
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
