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
): Promise<ResyAuthTokens | null> {
  try {
    const body = new URLSearchParams({ email, password });

    const response = await fetch(`${RESY_API_BASE}/3/auth/password`, {
      method: "POST",
      headers: {
        Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Origin: "https://resy.com",
        Referer: "https://resy.com/",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[ResyAuth] Login failed: ${response.status} — ${text}`);
      return null;
    }

    const data = await response.json();
    const authToken = data.token;
    const paymentMethods = data.payment_method_id
      ? data.payment_method_id
      : data.payment_methods?.[0]?.id ?? null;

    const result: ResyAuthTokens = {
      authToken,
      paymentMethodId: paymentMethods,
      firstName: data.first_name ?? "",
      lastName: data.last_name ?? "",
      email: data.em_address ?? email,
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

// ─── Full Auto-Book Flow ────────────────────────────────────────────────────

/**
 * Complete auto-book: get details → book → return result.
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

  return {
    ...result,
    restaurantName,
    date,
    time,
    partySize,
  };
}
