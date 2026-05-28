/**
 * Upstash Redis client for persistent storage of scheduled snipes.
 *
 * Required env vars:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

import { Redis } from "@upstash/redis";

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.warn("[Redis] Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
    return null;
  }
  redis = new Redis({ url, token });
  return redis;
}

// ─── Scheduled Snipe Types ─────────────────────────────────────────────────

export interface ScheduledSnipe {
  id: string;
  restaurantIds: string[];
  restaurantNames: string[];
  dates: string[];
  preferredTimes: string[];
  timeRadius: number;
  snipeWindowSeconds: number;
  partySize: number;
  dropTime: string; // "HH:MM" ET
  authToken: string;
  status: "waiting" | "running" | "completed" | "failed";
  result?: string;
  createdAt: string;
  qstashMessageId?: string;
}

const SNIPES_KEY = "wolfepack:scheduled_snipes";

// ─── CRUD Operations ────────────────────────────────────────────────────────

export async function listScheduledSnipes(): Promise<ScheduledSnipe[]> {
  const r = getRedis();
  if (!r) return [];
  const data = await r.get<ScheduledSnipe[]>(SNIPES_KEY);
  return data ?? [];
}

export async function addScheduledSnipe(snipe: ScheduledSnipe): Promise<void> {
  const r = getRedis();
  if (!r) throw new Error("Redis not configured");
  const existing = await listScheduledSnipes();
  existing.push(snipe);
  await r.set(SNIPES_KEY, existing);
}

export async function updateScheduledSnipe(
  id: string,
  updates: Partial<ScheduledSnipe>,
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  const snipes = await listScheduledSnipes();
  const idx = snipes.findIndex((s) => s.id === id);
  if (idx === -1) return;
  snipes[idx] = { ...snipes[idx], ...updates };
  await r.set(SNIPES_KEY, snipes);
}

export async function removeScheduledSnipe(id: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  const snipes = await listScheduledSnipes();
  const filtered = snipes.filter((s) => s.id !== id);
  await r.set(SNIPES_KEY, filtered);
}

export async function getScheduledSnipe(id: string): Promise<ScheduledSnipe | null> {
  const snipes = await listScheduledSnipes();
  return snipes.find((s) => s.id === id) ?? null;
}

// ─── Cleanup: Remove old completed/failed snipes ───────────────────────────

export async function cleanupOldSnipes(): Promise<number> {
  const r = getRedis();
  if (!r) return 0;
  const snipes = await listScheduledSnipes();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
  const kept = snipes.filter(
    (s) => s.status === "waiting" || s.status === "running" || new Date(s.createdAt).getTime() > cutoff,
  );
  const removed = snipes.length - kept.length;
  if (removed > 0) await r.set(SNIPES_KEY, kept);
  return removed;
}

// ─── Cookie Persistence (Pre-warm → Snipe handoff) ────────────────────────
// Pre-warm saves Imperva cookies to Redis; snipe loads them on startup.
// TTL of 3 minutes: long enough to bridge the 90s gap, short enough to
// prevent stale cookies accumulating.

export async function savePrewarmCookies(
  snipeId: string,
  cookies: Record<string, string>,
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(`wolfepack:cookies:${snipeId}`, cookies, { ex: 180 });
  console.log(`[Redis] Saved ${Object.keys(cookies).length} pre-warm cookies for snipe=${snipeId}`);
}

export async function loadPrewarmCookies(
  snipeId: string,
): Promise<Record<string, string> | null> {
  const r = getRedis();
  if (!r) return null;
  const cookies = await r.get<Record<string, string>>(`wolfepack:cookies:${snipeId}`);
  if (cookies && Object.keys(cookies).length > 0) {
    console.log(`[Redis] Loaded ${Object.keys(cookies).length} pre-warm cookies for snipe=${snipeId}`);
  }
  return cookies;
}

// ─── Global Cookie Pool (Cross-snipe WAF session sharing) ─────────────────
// When multiple snipes run concurrently on the same Vercel Fluid Compute
// instance (same IP), they share the same Imperva session. Storing the
// active WAF cookies globally means each warm-up is immediately available
// to all concurrent workers — avoiding redundant warm-up requests.
// TTL: 3 minutes.

const GLOBAL_COOKIES_KEY = "wolfepack:cookies:global";

export async function saveGlobalCookies(
  cookies: Record<string, string>,
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  if (Object.keys(cookies).length === 0) return;
  await r.set(GLOBAL_COOKIES_KEY, cookies, { ex: 180 });
}

export async function loadGlobalCookies(): Promise<Record<string, string> | null> {
  const r = getRedis();
  if (!r) return null;
  return r.get<Record<string, string>>(GLOBAL_COOKIES_KEY);
}

// ─── Notify Records ────────────────────────────────────────────────────────

export interface NotifyRecord {
  id: string;
  restaurantId: string;
  restaurantName: string;
  venueId: number;
  date: string;
  partySize: number;
  placedAt: string;
  status: "placed" | "failed";
  error?: string;
}

const NOTIFIES_KEY = "wolfepack:notifies";

export async function listNotifyRecords(): Promise<NotifyRecord[]> {
  const r = getRedis();
  if (!r) return [];
  const data = await r.get<NotifyRecord[]>(NOTIFIES_KEY);
  return data ?? [];
}

export async function addNotifyRecords(records: NotifyRecord[]): Promise<void> {
  const r = getRedis();
  if (!r) throw new Error("Redis not configured");
  const existing = await listNotifyRecords();
  // Deduplicate: don't add same restaurant+date+partySize twice
  const key = (rec: NotifyRecord) => `${rec.restaurantId}:${rec.date}:${rec.partySize}`;
  const existingKeys = new Set(existing.map(key));
  const newOnes = records.filter(rec => !existingKeys.has(key(rec)));
  if (newOnes.length === 0) return;
  await r.set(NOTIFIES_KEY, [...existing, ...newOnes]);
}

export async function removeNotifyRecord(id: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  const records = await listNotifyRecords();
  await r.set(NOTIFIES_KEY, records.filter((rec) => rec.id !== id));
}

export async function clearNotifyRecords(): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(NOTIFIES_KEY, []);
}
