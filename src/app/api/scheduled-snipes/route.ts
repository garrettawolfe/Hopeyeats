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
  return new Client({ token, baseUrl: "https://qstash.upstash.io" });
}

function nextDropTimestamp(dropTime: string): number {
  const [h, m] = dropTime.split(":").map(Number);
  const now = new Date();
  const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const target = new Date(etNow);
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= etNow.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  const etOffset = etNow.getTime() - now.getTime();
  const utcTarget = new Date(target.getTime() - etOffset);
  return Math.floor(utcTarget.getTime() / 1000);
}

export async function GET() {
  try {
    const snipes = await listScheduledSnipes();
    const safe = snipes.map(({ authToken: _a, ...rest }) => rest);
    return NextResponse.json({ snipes: safe });
  } catch (err) {
    console.error("[Scheduler] GET failed (Redis unavailable?):", err instanceof Error ? err.message : err);
    return NextResponse.json({ snipes: [], warning: "Could not reach storage — scheduled snipes temporarily unavailable" });
  }
}

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

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }

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
