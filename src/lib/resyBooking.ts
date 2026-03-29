/**
 * Resy Booking API — authenticate, get slot details, and auto-book.
 *
 * Flow:
 * 1. Login with email/password → get auth tokens + payment methods
 * 2. Find slot via /4/find (already in resyApi.ts)
 * 3. Get booking token via POST /3/details
 * 4. Book via POST /3/book
 */

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

// ─── In-Memory Auth Cache ───────────────────────────────────────────────────

let cachedAuth: ResyAuthTokens | null = null;

export function getCachedAuth(): ResyAuthTokens | null {
  return cachedAuth;
}

export function clearCachedAuth(): void {
  cachedAuth = null;
}

// ─── Headers ────────────────────────────────────────────────────────────────

function buildAuthHeaders(authToken: string): Record<string, string> {
  return {
    Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
    "X-Resy-Auth-Token": authToken,
    "X-Resy-Universal-Auth": authToken,
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://resy.com",
    Referer: "https://resy.com/",
  };
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
): Promise<SlotDetails | null> {
  try {
    const body = new URLSearchParams({
      config_id: configId,
      day: date,
      party_size: partySize.toString(),
    });

    const response = await fetch(`${RESY_API_BASE}/3/details`, {
      method: "POST",
      headers: buildAuthHeaders(authToken),
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[ResyBook] Details failed: ${response.status} — ${text}`);
      return null;
    }

    const data = await response.json();
    const bookToken = data.book_token?.value;

    if (!bookToken) {
      console.error("[ResyBook] No book_token in details response");
      return null;
    }

    return {
      bookToken,
      cancellationPolicy: data.cancellation?.display?.policy ?? undefined,
      depositAmount: data.book_token?.deposit_amount ?? undefined,
    };
  } catch (err) {
    console.error("[ResyBook] Details error:", err);
    return null;
  }
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
    });

    const response = await fetch(`${RESY_API_BASE}/3/book`, {
      method: "POST",
      headers: buildAuthHeaders(authToken),
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[ResyBook] Booking failed: ${response.status} — ${text}`);
      return {
        success: false,
        error: `Booking failed: ${response.status}. ${text}`,
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
    console.log(`[ResyBook] Fetched ${reservations.length} existing reservations`);
    return reservations;
  } catch (err) {
    console.error("[ResyBook] Error fetching reservations:", err);
    return existingReservations;
  }
}

/**
 * Check if a proposed booking conflicts with an existing reservation.
 * A conflict is: same date AND overlapping time window (within 2 hours).
 */
export function hasTimeConflict(
  existing: ExistingReservation[],
  date: string,
  time: string,
): boolean {
  if (!time) return false;

  const [newH, newM] = time.split(":").map(Number);
  const newMinutes = newH * 60 + newM;

  for (const res of existing) {
    if (res.date !== date) continue;
    if (!res.time) continue;

    const [exH, exM] = res.time.split(":").map(Number);
    const exMinutes = exH * 60 + exM;

    // Conflict if within 2 hours of each other
    if (Math.abs(newMinutes - exMinutes) < 120) {
      console.log(
        `[ResyBook] Conflict: existing ${res.venue} at ${res.time} on ${res.date} vs proposed ${time} on ${date}`,
      );
      return true;
    }
  }

  return false;
}

export function getExistingReservations(): ExistingReservation[] {
  return existingReservations;
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

  // Step 1: Get booking token
  const details = await getSlotDetails(authToken, configToken, date, partySize);
  if (!details) {
    return {
      success: false,
      error: "Could not get booking details — slot may no longer be available",
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
