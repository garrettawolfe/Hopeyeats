import { NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { warmUpImperva, hasValidCookies, exportCookies } from "@/lib/resyApi";
import { savePrewarmCookies, saveGlobalCookies } from "@/lib/scheduledSnipes";

export const maxDuration = 30;

async function verifyQStash(request: Request, body: string): Promise<boolean> {
  const signingKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!signingKey || !nextSigningKey) {
    if (process.env.NODE_ENV === "development") return true;
    return false;
  }
  const receiver = new Receiver({ currentSigningKey: signingKey, nextSigningKey: nextSigningKey });
  try {
    const signature = request.headers.get("upstash-signature") ?? "";
    if (!signature) return false;
    return await receiver.verify({ signature, body });
  } catch {
    return false;
  }
}

/**
 * POST /api/cron/snipe-prewarm
 * Scheduled by QStash 90s before the main snipe fires.
 * Warms the Vercel instance and fetches fresh Imperva cookies so the snipe
 * starts with a live instance (no cold-start penalty) and valid WAF cookies.
 */
export async function POST(request: Request) {
  const bodyText = await request.text();

  const isVerified = await verifyQStash(request, bodyText);
  if (!isVerified) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let snipeId = "unknown";
  try {
    const body = JSON.parse(bodyText);
    snipeId = body.snipeId ?? "unknown";
  } catch { /* ignore */ }

  console.log(`[Prewarm] Warming instance for snipe=${snipeId} — 90s before drop`);

  try {
    await warmUpImperva();
    const valid = hasValidCookies();
    console.log(`[Prewarm] Done — cookies valid=${valid}`);

    if (valid) {
      const cookies = exportCookies();
      // Save to global pool (shared by all concurrent snipes on same instance)
      await saveGlobalCookies(cookies).catch(() => {});
      if (snipeId !== "unknown") {
        await savePrewarmCookies(snipeId, cookies);
        console.log(`[Prewarm] Cookies saved to Redis (global + snipe=${snipeId})`);
      } else {
        console.log(`[Prewarm] Cookies saved to global pool`);
      }
    }
  } catch (err) {
    console.warn(`[Prewarm] Failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  return NextResponse.json({ ok: true, snipeId });
}
