import { NextResponse } from "next/server";
import { autoBook, autoBookWithRetry, getCachedAuth, setAuthFromToken, fetchExistingReservations, hasTimeConflict } from "@/lib/resyBooking";

/**
 * POST /api/resy-book
 * Auto-book a specific slot.
 *
 * Body: { configToken, date, partySize, restaurantName, time, authToken?, skipConflictCheck? }
 *   OR: { slots: [{configToken, date, time}], partySize, restaurantName, authToken? } for slot pool retry
 *
 * Auth: Uses cached auth if available, otherwise validates authToken from body.
 *
 * If a meal-period conflict exists (e.g., already have dinner that night),
 * returns 409 with { conflict: true, existingVenue, existingTime } unless
 * skipConflictCheck is true.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { configToken, date, partySize, restaurantName, time, slots, authToken, skipConflictCheck } = body;

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

    // Single slot mode
    if (!configToken || !date) {
      return NextResponse.json(
        { error: "configToken and date are required" },
        { status: 400 },
      );
    }

    // Meal-period conflict check (can be overridden by user confirmation)
    if (!skipConflictCheck && time) {
      try {
        const existing = await fetchExistingReservations(auth.authToken);
        const conflicting = findMealConflict(existing, date, time);
        if (conflicting) {
          return NextResponse.json(
            {
              conflict: true,
              existingVenue: conflicting.venue,
              existingTime: conflicting.time,
              existingDate: conflicting.date,
              error: `You already have a dinner reservation at ${conflicting.venue} on ${conflicting.date}`,
            },
            { status: 409 },
          );
        }
      } catch {
        // Continue without conflict check if fetch fails
      }
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

/**
 * Find the first existing reservation that conflicts by meal period.
 * Returns the conflicting reservation or null.
 */
function findMealConflict(
  existing: Array<{ venue: string; date: string; time: string }>,
  date: string,
  time: string,
): { venue: string; date: string; time: string } | null {
  const getMeal = (t: string) => {
    const [h] = t.split(":").map(Number);
    if (h < 11) return "breakfast";
    if (h < 16) return "lunch";
    return "dinner";
  };
  const proposedMeal = getMeal(time);
  for (const res of existing) {
    if (res.date !== date || !res.time) continue;
    if (getMeal(res.time) === proposedMeal) return res;
  }
  return null;
}
