import { NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { findAvailability, parseSlots, resetConsecutiveErrors, warmUpImperva, importCookiesFromPrewarm, hasValidCookies, exportCookies, pruneExpiredCookies, cookiesExpiringSoon } from "@/lib/resyApi";
import {
  getSlotDetails,
  bookReservation,
  prefetchPaymentMethod,
  type SlotDetails,
} from "@/lib/resyBooking";
import { restaurants } from "@/data/restaurants";
import { updateScheduledSnipe, loadPrewarmCookies, loadGlobalCookies, saveGlobalCookies } from "@/lib/scheduledSnipes";

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
    snipeWindowSeconds = 90,
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

  // ── Load pre-warm cookies from Redis, then warmup ────────────────────────
  // Pre-warm fires 90s before this and saves its Imperva cookies to Redis.
  // If the same Vercel region handles both requests, loading them here means
  // we skip a redundant warmup and start with fresh WAF cookies immediately.

  try {
    // 1. Try global cookie pool first (shared by all concurrent snipes on same instance)
    const globalCookies = await loadGlobalCookies();
    if (globalCookies && Object.keys(globalCookies).length > 0) {
      importCookiesFromPrewarm(globalCookies);
      console.log(`[Cron] Loaded ${Object.keys(globalCookies).length} cookies from global pool`);
    }

    // 2. Per-snipe pre-warm cookies override global (they're more specific / equally fresh)
    if (snipeId) {
      const cached = await loadPrewarmCookies(snipeId);
      if (cached && Object.keys(cached).length > 0) {
        importCookiesFromPrewarm(cached);
        console.log(`[Cron] Pre-warm cookies loaded from Redis (${Object.keys(cached).length}) — overriding global`);
      }
    }

    if (!hasValidCookies()) {
      console.log(`[Cron] No valid cookies in Redis — will warm up fresh`);
    }
  } catch (err) {
    console.warn("[Cron] Could not load cookies from Redis (non-fatal):", err instanceof Error ? err.message : String(err));
  }

  try {
    await warmUpImperva();
    if (hasValidCookies()) saveGlobalCookies(exportCookies()).catch(() => {});
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

  // 1200ms between loops stays under Resy's WAF threshold (~27 clean calls per ~35s window).
  // findAvailability adds its own 150–800ms gaussian jitter on top of this.
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
  const tokenAttempts = new Map<string, number>(); // track getSlotDetails failures before blacklisting
  const lastAvailableTimes = new Map<string, string>(); // deduplicate "no match" log lines
  const slotFirstSeen = new Map<string, number>(); // configToken → ms since startTime when first seen
  let lastProgressLog = startTime;
  let wafEpisodes = 0; // how many times we've backed off due to WAF
  // Failure type counters for final summary diagnosis
  let failCount403 = 0;
  let failCount412 = 0;
  let failCountOther = 0;

  // Stagger between parallel findAvailability calls — prevents burst pattern that
  // Imperva's behavioral ML flags. findAvailability's internal 150–800ms jitter only
  // applies relative to the shared lastRequestAt, which all concurrent calls read
  // simultaneously, so without this stagger they all fire nearly at once.
  const PARALLEL_STAGGER_MS = 200;

  try {
    while (Date.now() < deadline && !booked) {
      loopCount++;
      const callsThisLoop = targets.length * dates.length;

      // Prune expired Imperva cookies before each loop to avoid sending dead sessions.
      const pruned = pruneExpiredCookies();
      if (pruned > 0) {
        console.warn(`[Cron] Pruned ${pruned} expired cookie(s) — may need re-warm`);
      }

      // Proactively re-warm if cookies are about to expire in the next 30s
      if (cookiesExpiringSoon(30_000) && hasValidCookies()) {
        console.log(`[Cron] Cookies expiring soon — proactive re-warm`);
        try {
          await warmUpImperva();
          if (hasValidCookies()) saveGlobalCookies(exportCookies()).catch(() => {});
        } catch { /* non-fatal */ }
      }

      // Fire all restaurant×date availability checks in parallel with a stagger.
      // 200ms between each pair spreads 6 requests over ~1s, preventing the burst
      // pattern that Imperva's behavioral ML uses to distinguish bots from browsers.
      // allSettled preserves input order so we process targets in priority sequence.
      const pairs = targets.flatMap((r) => dates.map((d: string) => ({ restaurant: r, date: d })));
      apiCallCount += pairs.length;

      const availResults = await Promise.allSettled(
        pairs.map(({ restaurant, date }, idx) =>
          new Promise<{ restaurant: typeof targets[0]; date: string; result: Awaited<ReturnType<typeof findAvailability>> }>(
            (resolve, reject) => setTimeout(
              () => findAvailability(restaurant.resyVenueId!, date, partySize, authToken)
                .then((result) => resolve({ restaurant, date, result }))
                .catch(reject),
              idx * PARALLEL_STAGGER_MS
            )
          )
        )
      );

      let nullsThisLoop = 0;

      for (const ar of availResults) {
        if (booked) break;

        if (ar.status === "rejected") {
          nullsThisLoop++;
          continue;
        }

        const { restaurant, date, result } = ar.value;

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

        // Track first time we see each slot token (for post-mortem timing)
        const elapsedMs = Date.now() - startTime;
        for (const s of slots) {
          if (!slotFirstSeen.has(s.configToken)) slotFirstSeen.set(s.configToken, elapsedMs);
        }

        // Score slots against preferred times
        const blacklistedInWindow = slots.filter((s) => failedTokens.has(s.configToken));
        const scored = slots
          .filter((s) => !failedTokens.has(s.configToken))
          .map((s) => {
            const slotMin = parseInt(s.time.split(":")[0]) * 60 + parseInt(s.time.split(":")[1]);
            let score = 1000;
            if (preferredTimes.length > 0) {
              for (let i = 0; i < preferredTimes.length; i++) {
                const [ph, pm] = preferredTimes[i].split(":").map(Number);
                const diff = Math.abs(slotMin - (ph * 60 + pm));
                if (diff <= timeRadius) { score = i * 100 + diff; break; }
              }
            } else {
              score = 0;
            }
            return { slot: s, score };
          })
          .filter((s) => s.score < 1000)
          .sort((a, b) => a.score - b.score);

        if (blacklistedInWindow.length > 0 && scored.length === 0) {
          const blacklistedTimes = blacklistedInWindow.map((s) => s.time).join(", ");
          console.warn(`[Cron] loop=${loopCount} ${restaurant.name} ${date} — ${blacklistedInWindow.length} slot(s) SKIPPED (previously failed tokens): ${blacklistedTimes}`);
        }

        totalSlotsMatched += scored.length;

        if (scored.length === 0) {
          const availTimes = slots.map((s) => s.time).join(", ");
          const logKey = `${restaurant.id}:${date}`;
          if (lastAvailableTimes.get(logKey) !== availTimes) {
            const prev = lastAvailableTimes.get(logKey);
            const changeNote = prev ? ` (was: ${prev})` : "";
            console.log(`[Cron] loop=${loopCount} ${restaurant.name} ${date} — ${slots.length} slots but none in window [${preferredTimes.join(",")} ±${timeRadius}m] — available: ${availTimes}${changeNote}`);
            lastAvailableTimes.set(logKey, availTimes);
          }
          continue;
        }

        const elapsedSec = Math.round(elapsedMs / 1000);
        console.log(`[Cron] loop=${loopCount} T+${elapsedSec}s ${restaurant.name} ${date} — ${scored.length} matching slot(s), racing details in parallel (best: ${scored[0].slot.time} score=${scored[0].score})`);

        // Pre-flight warmup once so parallel getSlotDetails calls don't each re-warm concurrently.
        try { await warmUpImperva(); } catch { /* non-fatal */ }

        // Race all matched slots' /3/details calls simultaneously.
        const raceStart = Date.now();
        const raceResults = await Promise.allSettled(
          scored.map(async ({ slot }) => {
            const details = await getSlotDetails(authToken, slot.configToken, date, partySize);
            return { slot, details };
          })
        );
        const raceMs = Date.now() - raceStart;

        // Process in score order; track failures, book first success.
        let bookableWinner: { slot: typeof scored[0]["slot"]; details: SlotDetails } | null = null;

        for (const result of raceResults) {
          if (result.status === "rejected") {
            failCountOther++;
            console.warn(`[Cron] getSlotDetails threw unexpectedly: ${result.reason}`);
            continue;
          }
          const { slot, details } = result.value;
          if ("error" in details) {
            const attempts = (tokenAttempts.get(slot.configToken) ?? 0) + 1;
            tokenAttempts.set(slot.configToken, attempts);
            if (details.error.includes("locked") || details.error.includes("exclusive") || details.error.includes("403")) failCount403++;
            else if (details.error.includes("412") || details.error.includes("already booked")) failCount412++;
            else failCountOther++;
            if (attempts >= 2) {
              failedTokens.add(slot.configToken);
              console.warn(`[Cron] getSlotDetails failed ${attempts}x for ${slot.time} — blacklisting: ${details.error}`);
            } else {
              console.warn(`[Cron] getSlotDetails failed for ${slot.time} (attempt ${attempts}/2, will retry): ${details.error}`);
            }
          } else if (!bookableWinner) {
            bookableWinner = { slot, details };
          }
        }

        if (!bookableWinner) continue;

        const { slot, details } = bookableWinner;
        const firstSeenMs = slotFirstSeen.get(slot.configToken) ?? elapsedMs;
        const firstSeenSec = Math.round(firstSeenMs / 1000);
        console.log(`[Cron] Booking T+${elapsedSec}s (details raced in ${raceMs}ms, slot first seen T+${firstSeenSec}s): ${restaurant.name} ${slot.time} on ${date}`);

        const booking = await bookReservation(authToken, details.bookToken, paymentMethodId);
        if (booking.success) {
          booked = true;
          bookResult = { restaurant: restaurant.name, date, time: slot.time, reservationId: booking.reservationId };
          const firstSeenNote = firstSeenSec !== elapsedSec ? ` (first seen T+${firstSeenSec}s)` : "";
          console.log(`[Cron] BOOKED — ${restaurant.name} at ${slot.time} on ${date} | reservationId=${booking.reservationId ?? "n/a"} | T+${elapsedSec}s${firstSeenNote}`);
        } else {
          if (booking.error?.includes("412") || booking.error?.includes("already booked") || booking.error?.includes("token expired")) failCount412++;
          else if (booking.error?.includes("403") || booking.error?.includes("unavailable") || booking.error?.includes("membership")) failCount403++;
          else failCountOther++;
          console.warn(`[Cron] bookReservation failed for ${slot.time}: ${booking.error}`);
          failedTokens.add(slot.configToken);
        }
      }

      // WAF backoff: if every call in this loop returned null, the IP is blocked.
      // Exponential backoff (3s → 4.5s → 6.75s → capped at 8s) — much shorter than
      // the previous flat 12s. 5 episodes now cost ~30s instead of 60s.
      if (!booked && nullsThisLoop === callsThisLoop && callsThisLoop > 0) {
        wafEpisodes++;
        const backoffMs = Math.min(3_000 * Math.pow(1.5, wafEpisodes - 1), 8_000);
        const remaining = Math.round((deadline - Date.now()) / 1000);
        console.warn(`[Cron] WAF episode #${wafEpisodes} — all ${nullsThisLoop} calls blocked (loop=${loopCount}, ${remaining}s left). Backing off ${(backoffMs / 1000).toFixed(1)}s then re-warming.`);
        await new Promise((r) => setTimeout(r, backoffMs));
        try {
          await warmUpImperva();
          if (hasValidCookies()) saveGlobalCookies(exportCookies()).catch(() => {});
        } catch { /* non-fatal */ }
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
      const failBreakdown = (failCount403 + failCount412 + failCountOther) > 0
        ? ` [failures: ${failCount403} locked/exclusive, ${failCount412} already-booked, ${failCountOther} other]`
        : "";
      const reason = totalSlotsFound === 0
        ? wafEpisodes > 0
          ? `WAF blocked all requests (${wafEpisodes} episodes) — no slots retrieved`
          : `API returned 200 but no slots found (${apiCallCount} calls) — verify drop time or slots were grabbed instantly`
        : totalSlotsMatched === 0
          ? `Slots found (${totalSlotsFound}) but none matched preferred times [${preferredTimes.join(",")} ±${timeRadius}m]`
          : `Slots matched (${totalSlotsMatched}) but all booking attempts failed${failBreakdown}`;
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
