import { NextResponse } from "next/server";
import { warmUpImperva, hasValidCookies, buildHeaders } from "@/lib/resyApi";
import {
  addNotifyRecords,
  listNotifyRecords,
  removeNotifyRecord,
  type NotifyRecord,
} from "@/lib/scheduledSnipes";
import { restaurants } from "@/data/restaurants";

const RESY_API_BASE = "https://api.resy.com";

/**
 * POST /api/resy-notify
 * Places Resy "Notify Me" requests for multiple restaurant+date combinations.
 *
 * Body: { restaurantIds: string[], dates: string[], partySize: number, authToken: string }
 */
export async function POST(request: Request) {
  const t0 = Date.now();
  const serverLogs: string[] = [];
  function log(msg: string) {
    console.log(`[Notify] ${msg}`);
    serverLogs.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  }

  try {
    const body = await request.json();
    const { restaurantIds, dates, partySize = 2, dateTimes, authToken } = body;
    // dateTimes: Record<string, string[]> maps date → array of preferred times

    if (!authToken) {
      return NextResponse.json({ error: "authToken required" }, { status: 401 });
    }
    if (!restaurantIds?.length || !dates?.length) {
      return NextResponse.json({ error: "restaurantIds and dates required" }, { status: 400 });
    }

    const targets = restaurants.filter(
      (r) => restaurantIds.includes(r.id) && r.resyVenueId,
    );
    if (targets.length === 0) {
      return NextResponse.json({ error: "No valid Resy restaurants found" }, { status: 400 });
    }

    // Cap total requests to avoid WAF rate limits and Vercel timeout (60s)
    // 600-1000ms per request → max ~50 requests in 50s
    const totalSlots = dates.reduce((sum: number, d: string) => {
      const rawTimes = (dateTimes as Record<string, string | string[]>)?.[d];
      const times = Array.isArray(rawTimes) ? rawTimes : rawTimes ? [rawTimes] : [null];
      return sum + times.length;
    }, 0);
    const totalReqs = targets.length * totalSlots;
    if (totalReqs > 50) {
      return NextResponse.json({ error: `Too many requests (${totalReqs}). Reduce restaurants or time slots to stay under 50 total.` }, { status: 400 });
    }

    // Always warm up for notify — POST to /3/notify needs fresh WAF session
    log("Warming up WAF session for notify...");
    await warmUpImperva();
    log("Warm-up complete");

    type NotifyResult = { restaurantId: string; restaurantName: string; date: string; time?: string; success: boolean; error?: string };
    const results: NotifyResult[] = [];
    const recordsToSave: NotifyRecord[] = [];

    for (const restaurant of targets) {
      for (const date of dates) {
        // dateTimes[date] can be a string[] (multi-time) or string (legacy)
        const rawTimes = (dateTimes as Record<string, string | string[]>)?.[date];
        const times: string[] = Array.isArray(rawTimes) ? rawTimes : rawTimes ? [rawTimes] : [undefined as unknown as string];

        for (const time of times) {
          const label = `${restaurant.name} ${date}${time ? " " + time : ""}`;
          try {
            const notifyResult = await placeNotify(authToken, restaurant.resyVenueId!, date, partySize, time || undefined, serverLogs);
            if (notifyResult.success) {
              log(`✓ ${label}`);
            } else {
              log(`✗ ${label} — ${notifyResult.error}`);
            }
            results.push({
              restaurantId: restaurant.id,
              restaurantName: restaurant.name,
              date,
              time: time || undefined,
              success: notifyResult.success,
              error: notifyResult.error,
            });
            recordsToSave.push({
              id: `${restaurant.id}:${date}:${time ?? "any"}:${partySize}:${Date.now()}`,
              restaurantId: restaurant.id,
              restaurantName: restaurant.name,
              venueId: restaurant.resyVenueId!,
              date,
              partySize,
              placedAt: new Date().toISOString(),
              status: notifyResult.success ? "placed" : "failed",
              error: notifyResult.error,
            });
            await new Promise((r) => setTimeout(r, 600 + Math.random() * 400));
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`✗ ${label} — exception: ${errMsg}`);
            results.push({ restaurantId: restaurant.id, restaurantName: restaurant.name, date, time: time || undefined, success: false, error: errMsg });
            recordsToSave.push({
              id: `${restaurant.id}:${date}:${time ?? "any"}:${partySize}:${Date.now()}`,
              restaurantId: restaurant.id,
              restaurantName: restaurant.name,
              venueId: restaurant.resyVenueId!,
              date,
              partySize,
              placedAt: new Date().toISOString(),
              status: "failed",
              error: errMsg,
            });
          }
        }
      }
    }

    try {
      await addNotifyRecords(recordsToSave);
    } catch {
      log("Warning: failed to save records to Redis");
    }

    const placed = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    log(`DONE in ${Date.now() - t0}ms — placed=${placed} failed=${failed}`);

    return NextResponse.json({ placed, failed, results, serverLogs });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Notify error" },
      { status: 500 },
    );
  }
}

/** GET /api/resy-notify — list all placed notify records */
export async function GET() {
  try {
    const records = await listNotifyRecords();
    return NextResponse.json({ records });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Fetch error" },
      { status: 500 },
    );
  }
}

/** DELETE /api/resy-notify — remove a notify record by id */
export async function DELETE(request: Request) {
  try {
    const { id } = await request.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    await removeNotifyRecord(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Delete error" },
      { status: 500 },
    );
  }
}

async function placeNotify(
  authToken: string,
  venueId: number,
  date: string,
  partySize: number,
  timePreferred?: string,
  logBuf?: string[],
): Promise<{ success: boolean; error?: string }> {
  function pushLog(msg: string) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[Notify] ${msg}`);
    logBuf?.push(`${ts} ${msg}`);
  }

  const headers = buildHeaders(authToken);
  headers["Content-Type"] = "application/x-www-form-urlencoded";

  const params: Record<string, string> = {
    venue_id: venueId.toString(),
    day: date,
    num_seats: partySize.toString(),
    struct_data: JSON.stringify({
      day: date,
      num_seats: partySize,
      venue_id: venueId,
      ...(timePreferred ? { time_slot: `${timePreferred}:00` } : {}),
    }),
  };
  if (timePreferred) params.time_preferred = `${timePreferred}:00`;
  const body = new URLSearchParams(params).toString();

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${RESY_API_BASE}/3/notify`, {
        method: "POST",
        headers: buildHeaders(authToken), // rebuild headers each attempt (rotates persona)
        body,
      });

      if (res.ok || res.status === 201) return { success: true };
      if (res.status === 409) return { success: true }; // already on notify list

      const text = await res.text().catch(() => "");
      pushLog(`attempt ${attempt} /3/notify → ${res.status}: ${text.slice(0, 200)}`);

      // 502 = Imperva WAF block — re-warm and retry once
      if (res.status === 502 && attempt === 1) {
        pushLog("WAF block (502) — re-warming...");
        await warmUpImperva();
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    } catch (err) {
      if (attempt === 2) return { success: false, error: String(err) };
    }
  }
  return { success: false, error: "All attempts failed" };
}
