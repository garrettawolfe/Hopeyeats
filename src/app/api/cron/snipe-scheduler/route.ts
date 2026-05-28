import { NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import {
  findAvailability,
  parseSlots,
  resetConsecutiveErrors,
  warmUpImperva,
  hasValidCookies,
  exportCookies,
  importCookiesFromPrewarm,
  pruneExpiredCookies,
  cookiesExpiringSoon,
} from "@/lib/resyApi";
import {
  getSlotDetails,
  bookReservation,
  prefetchPaymentMethod,
  type SlotDetails,
} from "@/lib/resyBooking";
import { restaurants } from "@/data/restaurants";
import {
  updateScheduledSnipe,
  loadPrewarmCookies,
  loadGlobalCookies,
  saveGlobalCookies,
} from "@/lib/scheduledSnipes";

export const maxDuration = 120;

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

  console.log(`[Cron] START snipe=${snipeId} restaurants=${restaurantIds.length} dates=${dates.length} window=${snipeWindowSeconds}s`);

  if (snipeId) {
    await updateScheduledSnipe(snipeId, { status: "running" });
  }

  try {
    // Load pre-warmed cookies from Redis (global pool first, then per-snipe override)
    const globalCookies = await loadGlobalCookies();
    if (globalCookies && Object.keys(globalCookies).length > 0) {
      importCookiesFromPrewarm(globalCookies);
      console.log(`[Cron] Loaded ${Object.keys(globalCookies).length} global WAF cookies from Redis`);
    }
    if (snipeId) {
      const snipeCookies = await loadPrewarmCookies(snipeId);
      if (snipeCookies && Object.keys(snipeCookies).length > 0) {
        importCookiesFromPrewarm(snipeCookies);
        console.log(`[Cron] Loaded ${Object.keys(snipeCookies).length} per-snipe WAF cookies from Redis`);
      }
    }

    // Warm up WAF cookies and prefetch payment
    await warmUpImperva();
    if (hasValidCookies()) saveGlobalCookies(exportCookies()).catch(() => {});

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
    const slotFirstSeen = new Map<string, number>(); // configToken → ms since startTime
    let failCount403 = 0;
    let failCount412 = 0;
    let failCountOther = 0;

    // All restaurant×date pairs for parallel polling
    const pairs = targets.flatMap((restaurant) =>
      dates.map((date: string) => ({ restaurant, date }))
    );

    const PARALLEL_STAGGER_MS = 200;

    while (Date.now() < deadline && !booked) {
      attempt++;

      // Proactive cookie maintenance
      const pruned = pruneExpiredCookies();
      if (pruned > 0) console.log(`[Cron] Pruned ${pruned} expired cookies`);
      if (cookiesExpiringSoon(30_000) || !hasValidCookies()) {
        console.log(`[Cron] Re-warming WAF cookies (expiring soon or missing)`);
        await warmUpImperva();
        if (hasValidCookies()) saveGlobalCookies(exportCookies()).catch(() => {});
      }

      // Parallel availability checks with stagger to avoid burst WAF triggering
      const availResults = await Promise.allSettled(
        pairs.map(({ restaurant, date }, idx) =>
          new Promise<{ restaurant: typeof targets[0]; date: string; slots: ReturnType<typeof parseSlots> }>(
            (resolve, reject) =>
              setTimeout(() => {
                findAvailability(restaurant.resyVenueId!, date, partySize, authToken)
                  .then((result) => {
                    if (!result) return resolve({ restaurant, date, slots: [] });
                    resolve({
                      restaurant,
                      date,
                      slots: parseSlots(result, restaurant.resyVenueId!, restaurant.name, restaurant.resyUrl!, partySize),
                    });
                  })
                  .catch(reject);
              }, idx * PARALLEL_STAGGER_MS)
          )
        )
      );

      // Collect and score all matching slots across all pairs
      type ScoredSlot = { slot: ReturnType<typeof parseSlots>[0]; restaurant: typeof targets[0]; date: string; score: number };
      const allScored: ScoredSlot[] = [];
      for (const res of availResults) {
        if (res.status === "rejected") continue;
        const { restaurant, date, slots } = res.value;
        for (const slot of slots) {
          if (failedTokens.has(slot.configToken)) continue;
          let score = 1000;
          if (preferredTimes.length > 0) {
            const slotMin = parseInt(slot.time.split(":")[0]) * 60 + parseInt(slot.time.split(":")[1]);
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
          if (score < 1000) {
            if (!slotFirstSeen.has(slot.configToken)) {
              slotFirstSeen.set(slot.configToken, Date.now() - startTime);
            }
            allScored.push({ slot, restaurant, date, score });
          }
        }
      }

      if (allScored.length > 0) {
        allScored.sort((a, b) => a.score - b.score);
        const elapsed = Date.now() - startTime;
        console.log(`[Cron] attempt=${attempt} T+${elapsed}ms: ${allScored.length} slots, best=${allScored[0].restaurant.name} ${allScored[0].slot.time} (score=${allScored[0].score})`);

        // Parallel /3/details race across all matching slots
        const detailsResults = await Promise.allSettled(
          allScored.map(({ slot, date }) => getSlotDetails(authToken, slot.configToken, date, partySize))
        );

        let bookableWinner: { slot: ReturnType<typeof parseSlots>[0]; details: SlotDetails; restaurant: typeof targets[0] } | null = null;
        for (let i = 0; i < detailsResults.length; i++) {
          const dr = detailsResults[i];
          if (dr.status === "rejected" || "error" in dr.value) {
            const errMsg = dr.status === "rejected" ? String(dr.reason) : (dr.value as { error: string }).error;
            if (errMsg.includes("403")) failCount403++;
            else if (errMsg.includes("412")) failCount412++;
            else failCountOther++;
            failedTokens.add(allScored[i].slot.configToken);
            continue;
          }
          if (!bookableWinner) {
            bookableWinner = { slot: allScored[i].slot, details: dr.value as SlotDetails, restaurant: allScored[i].restaurant };
          }
        }

        if (bookableWinner) {
          const { slot, details, restaurant } = bookableWinner;
          const firstSeenMs = slotFirstSeen.get(slot.configToken) ?? 0;
          const booking = await bookReservation(authToken, details.bookToken, paymentMethodId);
          const totalElapsed = Date.now() - startTime;
          if (booking.success) {
            booked = true;
            bookResult = { restaurant: restaurant.name, date: slot.date, time: slot.time, reservationId: booking.reservationId };
            console.log(`[Cron] BOOKED! ${restaurant.name} at ${slot.time} on ${slot.date} — T+${totalElapsed}ms (first seen T+${firstSeenMs}ms)`);
          } else {
            failedTokens.add(slot.configToken);
            failCountOther++;
          }
        }
      }

      if (!booked) {
        await new Promise((r) => setTimeout(r, 300));
      }

      if (attempt % 10 === 0) {
        const elapsed = Date.now() - startTime;
        console.log(`[Cron] attempt=${attempt} T+${elapsed}ms fails=403:${failCount403}/412:${failCount412}/other:${failCountOther}`);
      }
    }

    const elapsed = Date.now() - startTime;

    if (booked && bookResult) {
      const result = `Booked ${bookResult.restaurant} at ${bookResult.time} on ${bookResult.date} (${attempt} attempts, ${Math.round(elapsed / 1000)}s)`;
      console.log(`[Cron] DONE ✓ ${result}`);
      if (snipeId) await updateScheduledSnipe(snipeId, { status: "completed", result });
    } else {
      const result = `No booking after ${attempt} attempts in ${Math.round(elapsed / 1000)}s — fails: 403=${failCount403} 412=${failCount412} other=${failCountOther}`;
      console.log(`[Cron] DONE ✗ ${result}`);
      if (snipeId) await updateScheduledSnipe(snipeId, { status: "failed", result });
    }

    return NextResponse.json({ booked, bookResult, attempts: attempt, elapsed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[Cron] ERROR: ${msg}`);
    if (snipeId) await updateScheduledSnipe(snipeId, { status: "failed", result: msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
