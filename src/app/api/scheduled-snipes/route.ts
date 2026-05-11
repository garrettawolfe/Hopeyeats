import { NextResponse } from "next/server";
import { Client } from "@upstash/qstash";
import {
  listScheduledSnipes,
  addScheduledSnipe,
  removeScheduledSnipe,
  cleanupOldSnipes,
  type ScheduledSnipe,
} from "@/lib/scheduledSnipes";

function getQStash(): Client | null {
  const token = process.env.QSTASH_TOKEN;
  if (!token) return null;
  // Explicit US/global endpoint — avoids eu-central-1 routing error when
  // token was created in the global region
  return new Client({ token, baseUrl: "https://qstash.upstash.io" });
}

/**
 * Compute the next occurrence of a drop time (ET) as a Unix timestamp.
 * If the drop time has already passed today, schedule for tomorrow.
 */
function nextDropTimestamp(dropTime: string): number {
  const [h, m] = dropTime.split(":").map(Number);
  const now = new Date();
  // Get current time in ET
  const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));

  // Build target date in ET
  const target = new Date(etNow);
  target.setHours(h, m, 0, 0);

  // If drop time already passed today, schedule for tomorrow
  if (target.getTime() <= etNow.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  // Convert ET target back to UTC
  // Get the offset between ET and UTC
  const etOffset = etNow.getTime() - now.getTime();
  const utcTarget = new Date(target.getTime() - etOffset);

  return Math.floor(utcTarget.getTime() / 1000);
}

/**
 * GET /api/scheduled-snipes — list all scheduled snipes
 */
export async function GET() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return NextResponse.json({
      snipes: [],
      warning: "Redis not configured — add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars",
    });
  }
  try {
    const snipes = await listScheduledSnipes();
    // Strip auth tokens from response
    const safe = snipes.map(({ authToken: _a, ...rest }) => rest);
    return NextResponse.json({ snipes: safe });
  } catch (err) {
    // Redis configured but unreachable
    console.error("[Scheduler] GET failed (Redis connection error):", err instanceof Error ? err.message : err);
    return NextResponse.json({ snipes: [], warning: "Could not reach Redis — check UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN" });
  }
}

/**
 * POST /api/scheduled-snipes — create a new scheduled snipe
 *
 * Body: {
 *   restaurantIds, restaurantNames, dates, preferredTimes,
 *   timeRadius, snipeWindowSeconds, partySize, dropTime, authToken
 * }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      restaurantIds,
      restaurantNames,
      dates,
      preferredTimes,
      timeRadius = 30,
      snipeWindowSeconds = 60,
      partySize = 2,
      dropTime,
      authToken,
    } = body;

    if (!restaurantIds?.length || !dates?.length || !preferredTimes?.length || !dropTime || !authToken) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const snipeId = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    // NEXT_PUBLIC_APP_URL must be set to the stable production URL (e.g. https://hopeyeats.vercel.app)
    // VERCEL_URL is deployment-specific and may 404 by the time QStash fires hours later
    const appUrl = process.env.NEXT_PUBLIC_APP_URL
      ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null)
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
      ?? "http://localhost:3000";

    // Schedule via QStash
    const qstash = getQStash();
    let qstashMessageId: string | undefined;

    if (qstash) {
      const notBefore = nextDropTimestamp(dropTime);
      const snipePayload = {
        snipeId,
        restaurantIds,
        dates,
        preferredTimes,
        timeRadius,
        snipeWindowSeconds,
        partySize,
        authToken,
      };

      const result = await qstash.publishJSON({
        url: `${appUrl}/api/cron/snipe-scheduler`,
        body: snipePayload,
        notBefore,
        retries: 2,
      });

      qstashMessageId = result.messageId;
      console.log(`[Scheduler] QStash scheduled snipe ${snipeId} for ${dropTime} ET (msg: ${qstashMessageId})`);
    } else {
      console.warn("[Scheduler] QStash not configured — snipe saved but won't auto-fire");
    }

    const snipe: ScheduledSnipe = {
      id: snipeId,
      restaurantIds,
      restaurantNames: restaurantNames ?? [],
      dates,
      preferredTimes,
      timeRadius,
      snipeWindowSeconds,
      partySize,
      dropTime,
      authToken,
      status: "waiting",
      createdAt: new Date().toISOString(),
      qstashMessageId,
    };

    await addScheduledSnipe(snipe);

    // Cleanup old snipes while we're at it
    await cleanupOldSnipes();

    return NextResponse.json({
      id: snipeId,
      dropTime,
      qstashScheduled: !!qstashMessageId,
      message: qstashMessageId
        ? `Snipe scheduled for ${dropTime} ET. It will run automatically.`
        : "Snipe saved but QStash not configured — add QSTASH_TOKEN env var for auto-fire.",
    });
  } catch (err) {
    console.error("[Scheduler] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to schedule snipe" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/scheduled-snipes?id=xxx — remove a scheduled snipe
 */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }

    // Cancel QStash message if possible
    const snipes = await listScheduledSnipes();
    const snipe = snipes.find((s) => s.id === id);
    if (snipe?.qstashMessageId) {
      const qstash = getQStash();
      if (qstash) {
        try {
          await qstash.messages.delete(snipe.qstashMessageId);
        } catch {
          // Message may have already been delivered
        }
      }
    }

    await removeScheduledSnipe(id);
    return NextResponse.json({ removed: id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to remove snipe" },
      { status: 500 },
    );
  }
}
