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

    if (!hasValidCookies()) {
      await warmUpImperva();
    }

    type NotifyResult = { restaurantId: string; restaurantName: string; date: string; time?: string; success: boolean; error?: string };
    const results: NotifyResult[] = [];
    const recordsToSave: NotifyRecord[] = [];

    for (const restaurant of targets) {
      for (const date of dates) {
        // dateTimes[date] can be a string[] (multi-time) or string (legacy)
        const rawTimes = (dateTimes as Record<string, string | string[]>)?.[date];
        const times: string[] = Array.isArray(rawTimes) ? rawTimes : rawTimes ? [rawTimes] : [undefined as unknown as string];

        for (const time of times) {
          try {
            const notifyResult = await placeNotify(authToken, restaurant.resyVenueId!, date, partySize, time || undefined);
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
            await new Promise((r) => setTimeout(r, 200 + Math.random() * 150));
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
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
      console.warn("[Notify] Failed to save records to Redis");
    }

    const placed = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    console.log(`[Notify] DONE in ${Date.now() - t0}ms — placed=${placed} failed=${failed}`);

    return NextResponse.json({ placed, failed, results });
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
): Promise<{ success: boolean; error?: string }> {
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

  try {
    const res = await fetch(`${RESY_API_BASE}/3/notify`, {
      method: "POST",
      headers,
      body,
    });

    if (res.ok || res.status === 201) return { success: true };
    if (res.status === 409) return { success: true }; // already on notify list

    const text = await res.text().catch(() => "");
    console.log(`[Notify] /3/notify → ${res.status}: ${text.slice(0, 200)}`);
    return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 120)}` };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
