import { NextResponse } from "next/server";
import { findAvailability, parseSlots, resetConsecutiveErrors } from "@/lib/resyApi";
import { getCachedAuth, getSlotDetails, bookReservation, warmupConnection, prefetchPaymentMethod } from "@/lib/resyBooking";
import { restaurants } from "@/data/restaurants";

export const maxDuration = 120;

/**
 * POST /api/resy-snipe
 *
 * Aggressively attempt to book a reservation for specific restaurants.
 * Uses tight polling (100-500ms) for a configurable window.
 *
 * Body: {
 *   restaurantIds: string[],       // which restaurants to target
 *   dates: string[],               // ["YYYY-MM-DD", ...] multiple dates supported
 *   date?: string,                 // single date (backwards compat)
 *   partySize: number,
 *   preferredTimes: string[],      // ["19:00", "19:30", "20:00"] in priority order
 *   timeRadius: number,            // minutes of flexibility (default 30)
 *   snipeWindowSeconds: number,    // how long to keep trying (default 30)
 *   pollIntervalMs: number,        // ms between attempts (default 300)
 *   authToken?: string,
 * }
 */
export async function POST(request: Request) {
  try {
    const auth = getCachedAuth();
    const body = await request.json();
    const {
      restaurantIds = [],
      dates: rawDates,
      date: singleDate,
      partySize = 2,
      preferredTimes = [],
      timeRadius = 30,
      snipeWindowSeconds = 30,
      pollIntervalMs = 300,
      authToken,
    } = body;

    // Support both `dates: [...]` and legacy `date: "..."`
    const dates: string[] = rawDates && Array.isArray(rawDates) && rawDates.length > 0
      ? rawDates
      : singleDate ? [singleDate] : [];

    const effectiveAuthToken = authToken ?? auth?.authToken;
    if (!effectiveAuthToken) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Warmup connection + pre-fetch payment method
    await Promise.all([
      warmupConnection(effectiveAuthToken),
      prefetchPaymentMethod(effectiveAuthToken),
    ]);

    const paymentMethodId = auth?.paymentMethodId ?? await prefetchPaymentMethod(effectiveAuthToken);
    if (!paymentMethodId) {
      return NextResponse.json({ error: "No payment method on file" }, { status: 400 });
    }

    // Resolve target restaurants
    const targets = restaurants.filter(
      r => restaurantIds.includes(r.id) && r.resyVenueId
    );

    if (targets.length === 0 || dates.length === 0) {
      return NextResponse.json({ error: "No valid targets or dates" }, { status: 400 });
    }

    resetConsecutiveErrors();

    // Stream results
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const write = async (data: unknown) => {
      await writer.write(encoder.encode(JSON.stringify(data) + "\n"));
    };

    const processAsync = async () => {
      const startTime = Date.now();
      const deadline = startTime + snipeWindowSeconds * 1000;
      let attempt = 0;
      let booked = false;
      const failedTokens = new Set<string>();

      await write({ type: "started", targets: targets.map(t => t.name), dates, partySize });

      while (Date.now() < deadline && !booked) {
        attempt++;
        await write({ type: "attempt", attempt, elapsed: Date.now() - startTime });

        for (const restaurant of targets) {
          if (booked) break;

          for (const date of dates) {
            if (booked) break;

            try {
              const result = await findAvailability(
                restaurant.resyVenueId!,
                date,
                partySize,
                effectiveAuthToken,
              );

              if (!result) continue;

              const slots = parseSlots(
                result,
                restaurant.resyVenueId!,
                restaurant.name,
                restaurant.resyUrl!,
                partySize,
              );

              if (slots.length === 0) continue;

              // Sort slots by preference
              const scored = slots
                .filter(s => !failedTokens.has(s.configToken))
                .map(s => {
                  let score = 1000;
                  if (preferredTimes.length > 0) {
                    const slotMinutes = parseInt(s.time.split(":")[0]) * 60 + parseInt(s.time.split(":")[1]);
                    for (let i = 0; i < preferredTimes.length; i++) {
                      const [ph, pm] = preferredTimes[i].split(":").map(Number);
                      const prefMinutes = ph * 60 + pm;
                      const diff = Math.abs(slotMinutes - prefMinutes);
                      if (diff <= timeRadius) {
                        score = i * 100 + diff;
                        break;
                      }
                    }
                  } else {
                    score = 0;
                  }
                  return { slot: s, score };
                })
                .filter(s => s.score < 1000)
                .sort((a, b) => a.score - b.score);

              if (scored.length === 0) continue;

              await write({
                type: "slots_found",
                restaurant: restaurant.name,
                date,
                count: scored.length,
                bestTime: scored[0].slot.time,
              });

              // Try to book the best matching slot
              for (const { slot } of scored) {
                const details = await getSlotDetails(
                  effectiveAuthToken,
                  slot.configToken,
                  date,
                  partySize,
                );

                if (!details) {
                  failedTokens.add(slot.configToken);
                  continue;
                }

                const bookResult = await bookReservation(
                  effectiveAuthToken,
                  details.bookToken,
                  paymentMethodId,
                );

                if (bookResult.success) {
                  booked = true;
                  await write({
                    type: "booked",
                    restaurant: restaurant.name,
                    date,
                    time: slot.time,
                    reservationId: bookResult.reservationId,
                  });
                  break;
                } else {
                  failedTokens.add(slot.configToken);
                  await write({
                    type: "book_failed",
                    restaurant: restaurant.name,
                    date,
                    time: slot.time,
                    error: bookResult.error,
                  });
                }
              }
            } catch (err) {
              await write({
                type: "error",
                restaurant: restaurant.name,
                date,
                error: err instanceof Error ? err.message : "Unknown error",
              });
            }
          }
        }

        if (!booked) {
          await new Promise(r => setTimeout(r, pollIntervalMs));
        }
      }

      await write({
        type: "done",
        booked,
        attempts: attempt,
        elapsed: Date.now() - startTime,
        datesSearched: dates.length,
      });

      await writer.close();
    };

    processAsync();

    return new Response(stream.readable, {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Snipe error" },
      { status: 500 },
    );
  }
}
