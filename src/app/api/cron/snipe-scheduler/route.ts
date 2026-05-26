import { NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { findAvailability, parseSlots, resetConsecutiveErrors, warmUpImperva } from "@/lib/resyApi";
import {
  getSlotDetails,
  bookReservation,
  prefetchPaymentMethod,
} from "@/lib/resyBooking";
import { restaurants } from "@/data/restaurants";
import { updateScheduledSnipe } from "@/lib/scheduledSnipes";

export const maxDuration = 120;

async function verifyQStash(request: Request, body: string): Promise<boolean> {
  const signingKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!signingKey || !nextSigningKey) {
    if (process.env.NODE_ENV === "development") return true;
    console.warn("[Cron] QStash signing keys not configured — rejecting request");
    return false;
  }

  const receiver = new Receiver({ currentSigningKey: signingKey, nextSigningKey: nextSigningKey });

  try {
    const signature = request.headers.get("upstash-signature") ?? "";
    if (!signature) {
      console.warn("[Cron] No upstash-signature header present");
      return false;
    }
    const isValid = await receiver.verify({ signature, body });
    if (!isValid) console.warn("[Cron] QStash signature verification failed");
    return isValid;
  } catch (err) {
    console.warn("[Cron] QStash signature error:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * POST /api/cron/snipe-scheduler
 * Called by QStash at the scheduled drop time. Runs the snipe synchronously.
 */
export async function POST(request: Request) {
  const cronStart = Date.now();
  const bodyText = await request.text();

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

  // ── Validate inputs ───────────────────────────────────────────────────────

  if (!authToken) {
    console.error("[Cron] ABORT — no auth token in payload");
    if (snipeId) await updateScheduledSnipe(snipeId, { status: "failed", result: "No auth token in payload" });
    return NextResponse.json({ error: "No auth token" }, { status: 401 });
  }

  const targets = restaurants.filter((r) => restaurantIds.includes(r.id) && r.resyVenueId);

  if (targets.length === 0 || dates.length === 0) {
    const reason = targets.length === 0
      ? `No matching restaurants for IDs: [${restaurantIds.join(", ")}]`
      : `No dates provided`;
    console.error(`[Cron] ABORT — ${reason}`);
    if (snipeId) await updateScheduledSnipe(snipeId, { status: "failed", result: reason });
    return NextResponse.json({ error: reason }, { status: 400 });
  }

  if (snipeWindowSeconds > 100) {
    console.warn(`[Cron] snipeWindowSeconds=${snipeWindowSeconds} is close to Vercel's 120s limit — may timeout`);
  }

  // ── Log full config at start (critical for post-mortem) ───────────────────

  console.log(`[Cron] START snipe=${snipeId} window=${snipeWindowSeconds}s party=${partySize} token=...${authToken.slice(-6)}`);
  console.log(`[Cron] Targets: ${targets.map((r) => r.name).join(", ")}`);
  console.log(`[Cron] Dates: ${dates.join(", ")}`);
  console.log(`[Cron] PreferredTimes: ${preferredTimes.join(", ")} ±${timeRadius}min`);

  if (snipeId) await updateScheduledSnipe(snipeId, { status: "running" });

  // ── Warmup + payment method ───────────────────────────────────────────────

  try {
    await warmUpImperva();
  } catch (err) {
    console.warn("[Cron] Warmup failed (continuing without cookies):", err instanceof Error ? err.message : String(err));
  }

  const paymentMethodId = await prefetchPaymentMethod(authToken);
  if (!paymentMethodId) {
    console.error("[Cron] ABORT — no payment method on Resy account (token may be expired)");
    if (snipeId) await updateScheduledSnipe(snipeId, { status: "failed", result: "No payment method — auth token may be expired" });
    return NextResponse.json({ error: "No payment method" }, { status: 400 });
  }

  console.log(`[Cron] Payment method confirmed: ${paymentMethodId}`);

  // ── Snipe loop ────────────────────────────────────────────────────────────

  resetConsecutiveErrors();

  const setupElapsed = Math.round((Date.now() - cronStart) / 1000);
  console.log(`[Cron] Setup complete in ${setupElapsed}s — starting poll loop (effective window: ${snipeWindowSeconds - setupElapsed}s remaining)`);

  // Poll interval: 1200ms keeps single-restaurant snipes under Resy's WAF
  // threshold (~50 req/IP/35s). Multi-restaurant snipes already space out
  // naturally due to per-request jitter in findAvailability.
  const POLL_INTERVAL_MS = 1200;

  const startTime = Date.now();
  const deadline = startTime + snipeWindowSeconds * 1000;
  let loopCount = 0;
  let apiCallCount = 0;
  let totalSlotsFound = 0;
  let totalSlotsMatched = 0;
  let booked = false;
  let bookResult: { restaurant: string; date: string; time: string; reservationId?: string } | null = null;
  const failedTokens = new Set<string>();
  let lastProgressLog = startTime;
  let wafEpisodes = 0; // how many times we've backed off due to WAF

  try {
    while (Date.now() < deadline && !booked) {
      loopCount++;
      let nullsThisLoop = 0;
      const callsThisLoop = targets.length * dates.length;

      for (const restaurant of targets) {
        if (booked) break;

        for (const date of dates) {
          if (booked) break;

          try {
            apiCallCount++;
            const result = await findAvailability(
              restaurant.resyVenueId!,
              date,
              partySize,
              authToken,
            );

            if (!result) {
              nullsThisLoop++;
              continue;
            }

            const slots = parseSlots(
              result,
              restaurant.resyVenueId!,
              restaurant.name,
              restaurant.resyUrl!,
              partySize,
            );

            totalSlotsFound += slots.length;

            if (slots.length === 0) continue;

            // Score slots against preferred times
            const scored = slots
              .filter((s) => !failedTokens.has(s.configToken))
              .map((s) => {
                const slotMin = parseInt(s.time.split(":")[0]) * 60 + parseInt(s.time.split(":")[1]);
                let score = 1000;
                if (preferredTimes.length > 0) {
                  for (let i = 0; i < preferredTimes.length; i++) {
                    const [ph, pm] = preferredTimes[i].split(":").map(Number);
                    const diff = Math.abs(slotMin - (ph * 60 + pm));
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
              .filter((s) => s.score < 1000)
              .sort((a, b) => a.score - b.score);

            totalSlotsMatched += scored.length;

            if (scored.length === 0) {
              // Slots exist but none in our time window — log so we know what was available
              const availTimes = slots.map((s) => s.time).join(", ");
              console.log(`[Cron] loop=${loopCount} ${restaurant.name} ${date} — ${slots.length} slots but none in window [${preferredTimes.join(",")} ±${timeRadius}m] — available: ${availTimes}`);
              continue;
            }

            console.log(`[Cron] loop=${loopCount} ${restaurant.name} ${date} — ${scored.length} matching slots, best: ${scored[0].slot.time} (score=${scored[0].score})`);

            // Attempt booking starting with best match
            for (const { slot } of scored) {
              console.log(`[Cron] Booking attempt: ${restaurant.name} ${slot.time} on ${date} (token=${slot.configToken.slice(0, 20)}...)`);

              const details = await getSlotDetails(authToken, slot.configToken, date, partySize);
              if ("error" in details) {
                console.warn(`[Cron] getSlotDetails failed for ${slot.time}: ${details.error}`);
                failedTokens.add(slot.configToken);
                continue;
              }

              const booking = await bookReservation(authToken, details.bookToken, paymentMethodId);
              if (booking.success) {
                booked = true;
                bookResult = { restaurant: restaurant.name, date, time: slot.time, reservationId: booking.reservationId };
                console.log(`[Cron] BOOKED — ${restaurant.name} at ${slot.time} on ${date} | reservationId=${booking.reservationId ?? "n/a"}`);
                break;
              } else {
                console.warn(`[Cron] bookReservation failed for ${slot.time}: ${booking.error}`);
                failedTokens.add(slot.configToken);
              }
            }
          } catch (err) {
            console.error(`[Cron] Error checking ${restaurant.name} on ${date}:`, err instanceof Error ? err.message : String(err));
          }
        }
      }

      // WAF backoff: if every call in this loop returned null, the IP is blocked.
      // Pause 12s and re-warm — hammering a blocked IP just wastes the window.
      if (!booked && nullsThisLoop === callsThisLoop && callsThisLoop > 0) {
        wafEpisodes++;
        const remaining = Math.round((deadline - Date.now()) / 1000);
        console.warn(`[Cron] WAF episode #${wafEpisodes} — all ${nullsThisLoop} calls blocked (loop=${loopCount}, ${remaining}s left). Pausing 12s and re-warming.`);
        await new Promise((r) => setTimeout(r, 12_000));
        try { await warmUpImperva(); } catch { /* non-fatal */ }
      }

      // Periodic progress log every 10s so Vercel shows activity
      const now = Date.now();
      if (!booked && now - lastProgressLog >= 10_000) {
        const elapsed = Math.round((now - startTime) / 1000);
        console.log(`[Cron] Progress: ${elapsed}s elapsed, loop=${loopCount}, apiCalls=${apiCallCount}, slotsFound=${totalSlotsFound}, matched=${totalSlotsMatched}, wafEpisodes=${wafEpisodes}`);
        lastProgressLog = now;
      }

      if (!booked) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }

    // ── Final summary ─────────────────────────────────────────────────────

    const totalElapsed = Date.now() - startTime;
    const cronElapsed = Date.now() - cronStart;

    if (booked && bookResult) {
      const summary = `Booked ${bookResult.restaurant} at ${bookResult.time} on ${bookResult.date}`;
      console.log(`[Cron] DONE ✓ ${summary} | loops=${loopCount} apiCalls=${apiCallCount} slotsFound=${totalSlotsFound} matched=${totalSlotsMatched} wafEpisodes=${wafEpisodes} elapsed=${Math.round(totalElapsed / 1000)}s cronTotal=${Math.round(cronElapsed / 1000)}s`);
      if (snipeId) await updateScheduledSnipe(snipeId, { status: "completed", result: `${summary} (${loopCount} loops, ${apiCallCount} API calls, ${Math.round(totalElapsed / 1000)}s)` });
    } else {
      const reason = totalSlotsFound === 0
        ? wafEpisodes > 0
          ? `WAF blocked all requests (${wafEpisodes} episodes) — no slots retrieved`
          : "No slots returned by Resy"
        : totalSlotsMatched === 0
          ? `Slots found (${totalSlotsFound}) but none in preferred time window [${preferredTimes.join(",")} ±${timeRadius}m]`
          : `Slots matched (${totalSlotsMatched}) but all booking attempts failed`;
      console.log(`[Cron] DONE ✗ ${reason} | loops=${loopCount} apiCalls=${apiCallCount} slotsFound=${totalSlotsFound} matched=${totalSlotsMatched} wafEpisodes=${wafEpisodes} elapsed=${Math.round(totalElapsed / 1000)}s cronTotal=${Math.round(cronElapsed / 1000)}s`);
      if (snipeId) await updateScheduledSnipe(snipeId, { status: "failed", result: reason });
    }

    return NextResponse.json({ booked, bookResult, loops: loopCount, apiCalls: apiCallCount, elapsed: totalElapsed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[Cron] FATAL error after ${Math.round((Date.now() - startTime) / 1000)}s: ${msg}`);
    if (snipeId) await updateScheduledSnipe(snipeId, { status: "failed", result: `Fatal: ${msg}` });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
