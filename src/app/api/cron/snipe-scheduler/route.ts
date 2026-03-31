import { NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { findAvailability, parseSlots, resetConsecutiveErrors } from "@/lib/resyApi";
import {
  getSlotDetails,
  bookReservation,
  warmupConnection,
  prefetchPaymentMethod,
} from "@/lib/resyBooking";
import { restaurants } from "@/data/restaurants";
import { updateScheduledSnipe } from "@/lib/scheduledSnipes";

export const maxDuration = 120;

/**
 * Verify that the request comes from QStash (prevents unauthorized triggers).
 */
async function verifyQStash(request: Request, body: string): Promise<boolean> {
  const signingKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!signingKey || !nextSigningKey) {
    // If signing keys not set, allow in development
    if (process.env.NODE_ENV === "development") return true;
    console.warn("[Cron] QStash signing keys not configured");
    return false;
  }

  const receiver = new Receiver({
    currentSigningKey: signingKey,
    nextSigningKey: nextSigningKey,
  });

  try {
    const signature = request.headers.get("upstash-signature") ?? "";
    const isValid = await receiver.verify({ signature, body });
    return isValid;
  } catch {
    return false;
  }
}

/**
 * POST /api/cron/snipe-scheduler
 *
 * Called by QStash at the scheduled drop time.
 * Runs the snipe synchronously (no streaming — this is server-side).
 *
 * Body: {
 *   snipeId, restaurantIds, dates, preferredTimes,
 *   timeRadius, snipeWindowSeconds, partySize, authToken
 * }
 */
export async function POST(request: Request) {
  const bodyText = await request.text();

  // Verify QStash signature
  const isVerified = await verifyQStash(request, bodyText);
  if (!isVerified) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const {
    snipeId,
    restaurantIds = [],
    dates = [],
    preferredTimes = [],
    timeRadius = 30,
    snipeWindowSeconds = 60,
    partySize = 2,
    authToken,
  } = body;

  if (!authToken) {
    if (snipeId) await updateScheduledSnipe(snipeId, { status: "failed", result: "No auth token" });
    return NextResponse.json({ error: "No auth token" }, { status: 401 });
  }

  console.log(`[Cron] Starting scheduled snipe ${snipeId} — ${restaurantIds.length} restaurants, ${dates.length} dates`);

  // Mark as running
  if (snipeId) {
    await updateScheduledSnipe(snipeId, { status: "running" });
  }

  try {
    // Warmup + prefetch payment
    await Promise.all([
      warmupConnection(authToken),
      prefetchPaymentMethod(authToken),
    ]);

    const paymentMethodId = await prefetchPaymentMethod(authToken);
    if (!paymentMethodId) {
      if (snipeId) await updateScheduledSnipe(snipeId, { status: "failed", result: "No payment method" });
      return NextResponse.json({ error: "No payment method" }, { status: 400 });
    }

    const targets = restaurants.filter(
      (r) => restaurantIds.includes(r.id) && r.resyVenueId,
    );

    if (targets.length === 0 || dates.length === 0) {
      if (snipeId) await updateScheduledSnipe(snipeId, { status: "failed", result: "No valid targets or dates" });
      return NextResponse.json({ error: "No valid targets or dates" }, { status: 400 });
    }

    resetConsecutiveErrors();

    const startTime = Date.now();
    const deadline = startTime + snipeWindowSeconds * 1000;
    let attempt = 0;
    let booked = false;
    let bookResult: { restaurant: string; date: string; time: string; reservationId?: string } | null = null;
    const failedTokens = new Set<string>();

    while (Date.now() < deadline && !booked) {
      attempt++;

      for (const restaurant of targets) {
        if (booked) break;

        for (const date of dates) {
          if (booked) break;

          try {
            const result = await findAvailability(
              restaurant.resyVenueId!,
              date,
              partySize,
              authToken,
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

            // Score and sort by preference
            const scored = slots
              .filter((s) => !failedTokens.has(s.configToken))
              .map((s) => {
                let score = 1000;
                if (preferredTimes.length > 0) {
                  const slotMin = parseInt(s.time.split(":")[0]) * 60 + parseInt(s.time.split(":")[1]);
                  for (let i = 0; i < preferredTimes.length; i++) {
                    const [ph, pm] = preferredTimes[i].split(":").map(Number);
                    const prefMin = ph * 60 + pm;
                    if (Math.abs(slotMin - prefMin) <= timeRadius) {
                      score = i * 100 + Math.abs(slotMin - prefMin);
                      break;
                    }
                  }
                } else {
                  score = 0;
                }
                return { slot: s, score };
              })
              .filter((s) => s.score < 1000)
              .sort((a, b) => a.score - b.score);

            if (scored.length === 0) continue;

            console.log(`[Cron] ${restaurant.name} (${date}): ${scored.length} matching slots, best: ${scored[0].slot.time}`);

            for (const { slot } of scored) {
              const details = await getSlotDetails(authToken, slot.configToken, date, partySize);
              if ("error" in details) {
                failedTokens.add(slot.configToken);
                continue;
              }

              const booking = await bookReservation(authToken, details.bookToken, paymentMethodId);
              if (booking.success) {
                booked = true;
                bookResult = {
                  restaurant: restaurant.name,
                  date,
                  time: slot.time,
                  reservationId: booking.reservationId,
                };
                console.log(`[Cron] BOOKED! ${restaurant.name} at ${slot.time} on ${date}`);
                break;
              } else {
                failedTokens.add(slot.configToken);
              }
            }
          } catch (err) {
            console.error(`[Cron] Error checking ${restaurant.name} on ${date}:`, err);
          }
        }
      }

      if (!booked) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    const elapsed = Date.now() - startTime;

    if (snipeId) {
      if (booked && bookResult) {
        await updateScheduledSnipe(snipeId, {
          status: "completed",
          result: `Booked ${bookResult.restaurant} at ${bookResult.time} on ${bookResult.date} (${attempt} attempts, ${Math.round(elapsed / 1000)}s)`,
        });
      } else {
        await updateScheduledSnipe(snipeId, {
          status: "failed",
          result: `No booking after ${attempt} attempts in ${Math.round(elapsed / 1000)}s`,
        });
      }
    }

    return NextResponse.json({
      booked,
      bookResult,
      attempts: attempt,
      elapsed,
    });
  } catch (err) {
    console.error("[Cron] Snipe error:", err);
    if (snipeId) {
      await updateScheduledSnipe(snipeId, {
        status: "failed",
        result: err instanceof Error ? err.message : "Unknown error",
      });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Snipe error" },
      { status: 500 },
    );
  }
}
