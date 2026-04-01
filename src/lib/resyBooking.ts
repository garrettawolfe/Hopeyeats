/**
 * Resy Booking API — authenticate, get slot details, and auto-book.
 *
 * Flow:
 * 1. Login with email/password → get auth tokens + payment methods
 * 2. Find slot via /4/find (already in resyApi.ts)
 * 3. Get booking token via POST /3/details
 * 4. Book via POST /3/book
 */

import { getCookieHeader, warmUpImperva } from "@/lib/resyApi";

const RESY_API_BASE = "https://api.resy.com";
const RESY_API_KEY = "VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ResyAuthTokens {
  authToken: string;
  paymentMethodId: number | null;
  firstName: string;
  lastName: string;
  email: string;
}

export interface BookingResult {
  success: boolean;
  reservationId?: string;
  resyToken?: string;
  error?: string;
  restaurantName?: string;
  date?: string;
  time?: string;
  partySize?: number;
}

export interface SlotDetails {
  bookToken: string;
  cancellationPolicy?: string;
  depositAmount?: number;
}

export interface SlotDetailsError {
  error: string;
}

// ─── In-Memory Auth Cache ───────────────────────────────────────────────────

let cachedAuth: ResyAuthTokens | null = null;

export function getCachedAuth(): ResyAuthTokens | null {
  return cachedAuth;
}

export function clearCachedAuth(): void {
  cachedAuth = null;
}

/**
 * Set auth from a raw token (obtained from Resy website DevTools).
 * Validates the token by fetching user info from Resy.
 */
export async function setAuthFromToken(
  authToken: string,
): Promise<ResyAuthTokens | { error: string }> {
  try {
    // Validate the token by fetching user info
    const response = await fetch(`${RESY_API_BASE}/2/user`, {
      method: "GET",
      headers: {
        Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
        "X-Resy-Auth-Token": authToken,
        "X-Resy-Universal-Auth": authToken,
        Accept: "application/json",
        Origin: "https://resy.com",
        Referer: "https://resy.com/",
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[ResyAuth] Token validation failed: ${response.status} — ${text}`);
      return { error: `Invalid token — Resy returned ${response.status}` };
    }

    const data = await response.json();

    const result: ResyAuthTokens = {
      authToken,
      paymentMethodId: data.payment_method_id
        ?? data.payment_methods?.[0]?.id
        ?? null,
      firstName: data.first_name ?? data.bio?.first_name ?? "",
      lastName: data.last_name ?? data.bio?.last_name ?? "",
      email: data.em_address ?? data.bio?.em_address ?? "",
    };

    cachedAuth = result;
    console.log(`[ResyAuth] Token auth as ${result.firstName} ${result.lastName}`);
    return result;
  } catch (err) {
    console.error("[ResyAuth] Token validation error:", err);
    return { error: err instanceof Error ? err.message : "Token validation failed" };
  }
}

// ─── Headers ────────────────────────────────────────────────────────────────

// #1/#2: Coherent browser personas for booking requests (UA + Sec-CH-UA + Accept-Language)
const BOOKING_PERSONAS = [
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaMobile: "?0",
    secChUaPlatform: '"macOS"',
    acceptLang: "en-US,en;q=0.9",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaMobile: "?0",
    secChUaPlatform: '"Windows"',
    acceptLang: "en-US,en;q=0.9,es;q=0.8",
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    secChUa: "",  // Safari doesn't send Sec-CH-UA
    secChUaMobile: "",
    secChUaPlatform: "",
    acceptLang: "en-US,en;q=0.9",
  },
];

function buildAuthHeaders(authToken: string, forBooking = false): Record<string, string> {
  const origin = forBooking ? "https://widgets.resy.com" : "https://resy.com";
  const cookieHeaderValue = getCookieHeader();
  const persona = BOOKING_PERSONAS[Math.floor(Math.random() * BOOKING_PERSONAS.length)];

  const headers: Record<string, string> = {
    Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
    "X-Resy-Auth-Token": authToken,
    "X-Resy-Universal-Auth": authToken,
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: origin,
    Referer: `${origin}/`,
    "X-Origin": origin,
    "Cache-Control": "no-cache",
    "User-Agent": persona.ua,
    "Accept-Language": persona.acceptLang,  // #2: Rotated
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
  };
  // #1: Sec-CH-UA headers (Chrome only, Safari doesn't send them)
  if (persona.secChUa) {
    headers["Sec-CH-UA"] = persona.secChUa;
    headers["Sec-CH-UA-Mobile"] = persona.secChUaMobile;
    headers["Sec-CH-UA-Platform"] = persona.secChUaPlatform;
  }
  if (cookieHeaderValue) {
    headers["Cookie"] = cookieHeaderValue;
  }
  return headers;
}

// ─── Step 1: Login ──────────────────────────────────────────────────────────

/**
 * Authenticate with Resy using email/password.
 * Returns auth tokens and payment method info needed for booking.
 */
export async function resyLogin(
  email: string,
  password: string,
): Promise<ResyAuthTokens | { error: string } | null> {
  try {
    // Try JSON body first (Resy's current API format)
    let response = await fetch(`${RESY_API_BASE}/3/auth/password`, {
      method: "POST",
      headers: {
        Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://resy.com",
        Referer: "https://resy.com/",
      },
      body: JSON.stringify({ email, password }),
    });

    // If JSON fails with 500, try form-urlencoded as fallback
    if (response.status === 500) {
      console.log("[ResyAuth] JSON body returned 500, trying form-urlencoded...");
      const formBody = new URLSearchParams({ email, password });
      response = await fetch(`${RESY_API_BASE}/3/auth/password`, {
        method: "POST",
        headers: {
          Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Origin: "https://resy.com",
          Referer: "https://resy.com/",
        },
        body: formBody.toString(),
      });
    }

    // If still 500, try the legacy API key
    if (response.status === 500) {
      console.log("[ResyAuth] Trying legacy API key...");
      response = await fetch(`${RESY_API_BASE}/3/auth/password`, {
        method: "POST",
        headers: {
          Authorization: 'ResyAPI api_key="youarewhereyoueat"',
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Origin: "https://resy.com",
          Referer: "https://resy.com/",
        },
        body: new URLSearchParams({ email, password }).toString(),
      });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[ResyAuth] Login failed: ${response.status} — ${text}`);
      return { error: `Resy returned ${response.status}: ${text.slice(0, 200)}` };
    }

    const data = await response.json();
    console.log("[ResyAuth] Response keys:", Object.keys(data));

    // The token field varies between API versions
    const authToken = data.token ?? data.auth_token ?? data.Token;

    if (!authToken) {
      console.error("[ResyAuth] No auth token in response. Keys:", Object.keys(data));
      return null;
    }

    // Payment method ID can be in several places
    const paymentMethods = data.payment_method_id
      ?? data.payment_methods?.[0]?.id
      ?? data.PaymentMethodId
      ?? null;

    const result: ResyAuthTokens = {
      authToken,
      paymentMethodId: paymentMethods,
      firstName: data.first_name ?? data.FirstName ?? "",
      lastName: data.last_name ?? data.LastName ?? "",
      email: data.em_address ?? data.email ?? email,
    };

    cachedAuth = result;
    console.log(`[ResyAuth] Logged in as ${result.firstName} ${result.lastName}`);
    return result;
  } catch (err) {
    console.error("[ResyAuth] Login error:", err);
    return null;
  }
}

// ─── Step 2: Get Slot Details (Book Token) ──────────────────────────────────

/**
 * Get the booking token for a specific slot.
 * This is required before calling /3/book.
 */
export async function getSlotDetails(
  authToken: string,
  configId: string,
  date: string,
  partySize: number,
  paymentMethodId?: number | null,
): Promise<SlotDetails | SlotDetailsError> {
  const detailsStart = Date.now(); // #10: Booking attempt timing
  try {
    // Warm up Imperva cookies if needed (ensures WAF cookies are fresh)
    await warmUpImperva();

    // Resy /3/details requires application/json (415 error if form-encoded)
    const headers = buildAuthHeaders(authToken, true);
    headers["Content-Type"] = "application/json";

    // Include payment method for deposit-required venues (403/1026 without it)
    const bodyObj: Record<string, unknown> = {
      config_id: configId,
      day: date,
      party_size: partySize,
    };
    if (paymentMethodId != null) {
      bodyObj.struct_payment_method = { id: paymentMethodId };
    }

    const response = await fetch(`${RESY_API_BASE}/3/details`, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyObj),
    });

    const detailsMs = Date.now() - detailsStart;

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // #10: Log timing with status for attribution
      // 403 with code 1026 = slot unavailable/taken or venue requires special booking
      // 500 with request-id = Resy internal error (transient)
      const reason = response.status === 403 ? "slot unavailable or venue requires deposit"
        : response.status === 412 ? "slot already booked"
        : response.status === 500 ? "Resy internal error"
        : `HTTP ${response.status}`;
      console.error(`[ResyBook] Details ${response.status} in ${detailsMs}ms (${reason}) — ${text.slice(0, 300)}`);
      return { error: `${reason} (${detailsMs}ms)` } as SlotDetailsError;
    }

    const data = await response.json();
    const bookToken = data.book_token?.value;

    if (!bookToken) {
      console.error(`[ResyBook] No book_token in ${detailsMs}ms. Keys: ${Object.keys(data).join(",")}`);
      return { error: "No book_token in response" } as SlotDetailsError;
    }

    // #10: Log successful details fetch with timing
    console.log(`[ResyBook] Details OK in ${detailsMs}ms — ${date} party=${partySize}`);
    return {
      bookToken,
      cancellationPolicy: data.cancellation?.display?.policy ?? undefined,
      depositAmount: data.book_token?.deposit_amount ?? undefined,
    };
  } catch (err) {
    const detailsMs = Date.now() - detailsStart;
    console.error(`[ResyBook] Details EXCEPTION in ${detailsMs}ms: ${err instanceof Error ? err.message : String(err)}`);
    return { error: err instanceof Error ? err.message : "Details fetch error" } as SlotDetailsError;
  }
}

/**
 * #6: Fetch slot details in parallel for multiple slots.
 * Returns first successful result, or all errors if none succeed.
 * This avoids sequential /3/details calls when auto-booking.
 */
export async function getSlotDetailsParallel(
  authToken: string,
  slots: Array<{ configToken: string; date: string; time: string }>,
  partySize: number,
  paymentMethodId?: number | null,
): Promise<{ slot: typeof slots[0]; details: SlotDetails } | { errors: string[] }> {
  const batchStart = Date.now();
  console.log(`[ResyBook] #6 Parallel details fetch: ${slots.length} slots`);

  // Fetch all details in parallel
  const results = await Promise.all(
    slots.map(async (slot) => {
      const details = await getSlotDetails(authToken, slot.configToken, slot.date, partySize, paymentMethodId);
      return { slot, details };
    }),
  );

  const batchMs = Date.now() - batchStart;

  // Return first success
  for (const { slot, details } of results) {
    if (!("error" in details)) {
      console.log(`[ResyBook] #6 Parallel: found bookable slot ${slot.date} ${slot.time} in ${batchMs}ms (${slots.length} fetched)`);
      return { slot, details };
    }
  }

  // All failed
  const errors = results.map(({ slot, details }) =>
    `${slot.date} ${slot.time}: ${"error" in details ? details.error : "unknown"}`
  );
  console.log(`[ResyBook] #6 Parallel: all ${slots.length} failed in ${batchMs}ms`);
  return { errors };
}

// ─── Step 3: Book the Reservation ───────────────────────────────────────────

/**
 * Book a reservation using the book token from getSlotDetails.
 */
export async function bookReservation(
  authToken: string,
  bookToken: string,
  paymentMethodId: number,
): Promise<BookingResult> {
  try {
    const body = new URLSearchParams({
      book_token: bookToken,
      struct_payment_method: JSON.stringify({ id: paymentMethodId }),
      source_id: "resy.com-venue-details",
    });

    const response = await fetch(`${RESY_API_BASE}/3/book`, {
      method: "POST",
      headers: buildAuthHeaders(authToken, true),
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const statusLabel = response.status === 412 ? "slot already booked or token expired"
        : response.status === 403 ? "slot unavailable or venue requires deposit"
        : response.status === 409 ? "booking conflict"
        : `HTTP ${response.status}`;
      console.error(`[ResyBook] Booking failed: ${response.status} — ${text}`);
      return {
        success: false,
        error: `${statusLabel}. ${text}`.trim(),
      };
    }

    const data = await response.json();

    return {
      success: true,
      reservationId: data.reservation_id?.toString() ?? data.resy_token,
      resyToken: data.resy_token,
    };
  } catch (err) {
    console.error("[ResyBook] Booking error:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown booking error",
    };
  }
}

// ─── Existing Reservations (Conflict Detection) ────────────────────────────

export interface ExistingReservation {
  reservationId: string;
  venue: string;
  venueId: number;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  partySize: number;
}

/** Cache of existing reservations, refreshed periodically. */
let existingReservations: ExistingReservation[] = [];
let lastReservationFetch = 0;
const RESERVATION_CACHE_MS = 5 * 60 * 1000; // 5 minutes

/** Invalidate the reservation cache — call after a successful booking. */
export function invalidateReservationCache(): void {
  lastReservationFetch = 0;
}

/**
 * Fetch the user's upcoming reservations from Resy.
 */
export async function fetchExistingReservations(
  authToken: string,
): Promise<ExistingReservation[]> {
  // Use cache if fresh
  if (Date.now() - lastReservationFetch < RESERVATION_CACHE_MS && existingReservations.length > 0) {
    return existingReservations;
  }

  try {
    const response = await fetch(`${RESY_API_BASE}/3/user/reservations`, {
      method: "GET",
      headers: {
        Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
        "X-Resy-Auth-Token": authToken,
        "X-Resy-Universal-Auth": authToken,
        Accept: "application/json",
        Origin: "https://resy.com",
        Referer: "https://resy.com/",
      },
    });

    if (!response.ok) {
      console.error(`[ResyBook] Failed to fetch reservations: ${response.status}`);
      return existingReservations; // Return stale cache on error
    }

    const data = await response.json();
    const reservations: ExistingReservation[] = [];

    // Parse reservations from response (could be array or nested)
    const items = Array.isArray(data) ? data : data.reservations ?? [];
    for (const item of items) {
      const dateTime = item.when ?? item.day ?? "";
      const [datePart, timePart] = typeof dateTime === "string" && dateTime.includes(" ")
        ? dateTime.split(" ")
        : [item.day ?? dateTime, item.time_slot ?? ""];

      reservations.push({
        reservationId: String(item.reservation_id ?? item.resy_token ?? ""),
        venue: item.venue?.name ?? "",
        venueId: item.venue?.id?.resy ?? item.venue_id ?? 0,
        date: datePart,
        time: timePart ? timePart.substring(0, 5) : "",
        partySize: item.num_seats ?? 2,
      });
    }

    existingReservations = reservations;
    lastReservationFetch = Date.now();
    // Log parsed reservations for debugging conflict checks
    const upcoming = reservations.filter(r => r.date >= new Date().toISOString().split("T")[0]);
    console.log(`[ResyBook] Fetched ${reservations.length} existing reservations (${upcoming.length} upcoming): ${upcoming.map(r => `${r.venue} ${r.date} ${r.time}`).join(", ")}`);
    return reservations;
  } catch (err) {
    console.error("[ResyBook] Error fetching reservations:", err);
    return existingReservations;
  }
}

/**
 * Determine the meal period for a given time (HH:MM format).
 * - Breakfast: before 11:00
 * - Lunch: 11:00–15:59
 * - Dinner: 16:00+
 */
function getMealPeriod(time: string): "breakfast" | "lunch" | "dinner" {
  const [h] = time.split(":").map(Number);
  if (h < 11) return "breakfast";
  if (h < 16) return "lunch";
  return "dinner";
}

/**
 * Check if a proposed booking conflicts with an existing reservation.
 * A conflict is: same date AND same meal period (breakfast/lunch/dinner).
 */
export function hasTimeConflict(
  existing: ExistingReservation[],
  date: string,
  time: string,
): boolean {
  if (!time) return false;

  const proposedMeal = getMealPeriod(time);
  const sameDateRes = existing.filter(r => r.date === date);
  if (sameDateRes.length > 0) {
    console.log(`[ResyBook] Conflict check: proposed ${date} ${time} (${proposedMeal}) vs ${sameDateRes.length} existing on same date: ${sameDateRes.map(r => `${r.venue} ${r.time}`).join(", ")}`);
  }

  for (const res of existing) {
    if (res.date !== date) continue;
    if (!res.time) continue;

    const existingMeal = getMealPeriod(res.time);

    if (proposedMeal === existingMeal) {
      console.log(
        `[ResyBook] Meal conflict: existing ${res.venue} ${existingMeal} at ${res.time} on ${res.date} vs proposed ${proposedMeal} at ${time} on ${date}`,
      );
      return true;
    }
  }

  return false;
}

export function getExistingReservations(): ExistingReservation[] {
  return existingReservations;
}

// ─── Payment Method Pre-Caching ────────────────────────────────────────────

let cachedPaymentMethodId: number | null = null;

export async function prefetchPaymentMethod(authToken: string): Promise<number | null> {
  if (cachedPaymentMethodId) return cachedPaymentMethodId;

  try {
    const response = await fetch(`${RESY_API_BASE}/2/user`, {
      method: "GET",
      headers: {
        Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
        "X-Resy-Auth-Token": authToken,
        "X-Resy-Universal-Auth": authToken,
        Accept: "application/json",
      },
    });
    if (!response.ok) return null;
    const data = await response.json();
    cachedPaymentMethodId = data.payment_method_id ?? data.payment_methods?.[0]?.id ?? null;
    return cachedPaymentMethodId;
  } catch {
    return null;
  }
}

// ─── Connection Warmup ─────────────────────────────────────────────────────

export async function warmupConnection(authToken: string): Promise<void> {
  try {
    await fetch(`${RESY_API_BASE}/2/user`, {
      method: "GET",
      headers: {
        Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
        "X-Resy-Auth-Token": authToken,
        Accept: "application/json",
      },
    });
  } catch {
    // Warmup failure is non-fatal
  }
}

// ─── Full Auto-Book Flow ────────────────────────────────────────────────────

/**
 * Complete auto-book: check conflicts → get details → book → return result.
 * Requires an authenticated session (call resyLogin first).
 */
export async function autoBook(
  authToken: string,
  paymentMethodId: number,
  configToken: string,
  date: string,
  partySize: number,
  restaurantName: string,
  time: string,
): Promise<BookingResult> {
  // Step 0: Check for conflicts with existing reservations
  const existing = await fetchExistingReservations(authToken);
  if (hasTimeConflict(existing, date, time)) {
    return {
      success: false,
      error: `Skipped — you already have a reservation near ${time} on ${date}`,
      restaurantName,
      date,
      time,
      partySize,
    };
  }

  // Step 1: Get booking token (pass paymentMethodId for deposit-required venues like Cote)
  const details = await getSlotDetails(authToken, configToken, date, partySize, paymentMethodId);
  if ("error" in details) {
    return {
      success: false,
      error: `Booking details failed: ${details.error}`,
      restaurantName,
      date,
      time,
      partySize,
    };
  }

  // Step 2: Book it
  const result = await bookReservation(
    authToken,
    details.bookToken,
    paymentMethodId,
  );

  // Step 3: Refresh reservation cache after booking
  if (result.success) {
    lastReservationFetch = 0; // Force refresh on next check
  }

  return {
    ...result,
    restaurantName,
    date,
    time,
    partySize,
  };
}

// ─── Slot Pool with Retry Logic ────────────────────────────────────────────

/**
 * Try booking from a pool of slots with retry logic.
 * Iterates through slots in sequence, retrying with delays up to maxRetries times.
 */
export async function autoBookWithRetry(
  authToken: string,
  paymentMethodId: number,
  slots: Array<{ configToken: string; date: string; time: string }>,
  partySize: number,
  restaurantName: string,
  maxRetries: number = 5,
  retryDelayMs: number = 500,
): Promise<BookingResult> {
  const existing = await fetchExistingReservations(authToken);
  const failedTokens = new Set<string>();
  const errors: string[] = [];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (const slot of slots) {
      if (failedTokens.has(slot.configToken)) continue;
      if (hasTimeConflict(existing, slot.date, slot.time)) {
        errors.push(`${slot.date} ${slot.time}: time conflict with existing reservation`);
        failedTokens.add(slot.configToken);
        continue;
      }

      const details = await getSlotDetails(authToken, slot.configToken, slot.date, partySize, paymentMethodId);
      if ("error" in details) {
        errors.push(`${slot.date} ${slot.time}: ${details.error}`);
        failedTokens.add(slot.configToken);
        continue;
      }

      const result = await bookReservation(authToken, details.bookToken, paymentMethodId);
      if (result.success) {
        lastReservationFetch = 0;
        return { ...result, restaurantName, date: slot.date, time: slot.time, partySize };
      }

      errors.push(`${slot.date} ${slot.time}: ${result.error ?? "booking failed"}`);
      failedTokens.add(slot.configToken);
    }

    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }

  return {
    success: false,
    error: `Failed after ${maxRetries} attempts across ${slots.length} slots. Last errors: ${errors.slice(-3).join(" | ")}`,
    restaurantName,
    partySize,
  };
}
