import { NextResponse } from "next/server";
import { autoBook, getCachedAuth } from "@/lib/resyBooking";

/**
 * POST /api/resy-book
 * Auto-book a specific slot. Requires prior auth via /api/resy-auth.
 *
 * Body: { configToken, date, partySize, restaurantName, time }
 */
export async function POST(request: Request) {
  try {
    const auth = getCachedAuth();
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

    const { configToken, date, partySize, restaurantName, time } =
      await request.json();

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
