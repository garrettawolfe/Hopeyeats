import { NextResponse } from "next/server";
import { autoBook, autoBookWithRetry, getCachedAuth, setAuthFromToken } from "@/lib/resyBooking";

/**
 * POST /api/resy-book
 * Auto-book a specific slot.
 *
 * Body: { configToken, date, partySize, restaurantName, time, authToken? }
 *   OR: { slots: [{configToken, date, time}], partySize, restaurantName, authToken? } for slot pool retry
 *
 * Auth: Uses cached auth if available, otherwise validates authToken from body.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { configToken, date, partySize, restaurantName, time, slots, authToken } = body;

    // Try cached auth first; if unavailable, validate the token from request body
    let auth = getCachedAuth();
    if (!auth && authToken) {
      console.log("[Book] No cached auth, validating token from request body");
      const result = await setAuthFromToken(authToken);
      if ("error" in result) {
        return NextResponse.json(
          { error: `Auth failed: ${result.error}` },
          { status: 401 },
        );
      }
      auth = result;
    }

    if (!auth) {
      return NextResponse.json(
        { error: "Not authenticated — log in to Resy first" },
        { status: 401 },
      );
    }

    if (!auth.paymentMethodId) {
      return NextResponse.json(
        { error: "No payment method on file — add one in your Resy account" },
        { status: 400 },
      );
    }

    // Slot pool mode: try multiple slots with retry
    if (slots && Array.isArray(slots) && slots.length > 0) {
      const result = await autoBookWithRetry(
        auth.authToken,
        auth.paymentMethodId,
        slots,
        partySize ?? 2,
        restaurantName ?? "Restaurant",
      );

      if (!result.success) {
        return NextResponse.json({ error: result.error, ...result }, { status: 422 });
      }
      return NextResponse.json(result);
    }

    // Single slot mode (backwards compatible)
    if (!configToken || !date) {
      return NextResponse.json(
        { error: "configToken and date are required" },
        { status: 400 },
      );
    }

    const result = await autoBook(
      auth.authToken,
      auth.paymentMethodId,
      configToken,
      date,
      partySize ?? 2,
      restaurantName ?? "Restaurant",
      time ?? "",
    );

    if (!result.success) {
      return NextResponse.json(
        { error: result.error, ...result },
        { status: 422 },
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("[Book] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Booking error" },
      { status: 500 },
    );
  }
}
