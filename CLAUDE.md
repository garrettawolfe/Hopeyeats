# HopeYeats — Codebase Guide

## Overview

HopeYeats is a Next.js 16 (App Router) application that monitors Resy restaurant reservation availability, auto-books slots, and sends notifications. Built with TypeScript, Tailwind CSS, and Upstash (Redis + QStash) for persistence and scheduling.

## Commands

```bash
npm run dev          # start Next.js dev server (Turbopack)
npm run build        # production build
npm test             # run vitest unit tests (39 tests)
npm run typecheck    # tsc --noEmit
npm run verify:venues  # validate all resyVenueId values via Resy API
```

## Architecture

### Frontend (`src/app/page.tsx`)

Single-page React app. All state lives here:

- **Auth**: `authToken`, `paymentMethodId` stored in `localStorage` via `useEffect` on load
- **Poll loop**: `useInterval`-style pattern using `useRef` + `setTimeout` in `startMonitoring()`
- **WAF backoff**: `consecutiveFailsRef` (ref, for stale-closure-safe reads) + `consecutiveFails` (state, for DebugPanel display)
- **Smart polling tiers**: tier1 = auto-book restaurants (every poll), tier2 = monitor-only (rotated in groups of ~10)
- **Debug log**: `debugLog: LogEntry[]` — 200-entry rolling buffer fed by `addLog(level, module, msg, data?)`
- **Memoized computations**: `debugErrorCount`, `monitoredNames`, `autoBookNames` — keep renders O(1) on the hot path
- **Global error capture**: `window.onerror` and `unhandledrejection` both routed into `addLog("error", "ui", ...)`

### Components

| Component | Purpose |
|-----------|---------|
| `src/components/DebugPanel.tsx` | Floating debug panel with system snapshot, level/module filters, "Copy for Claude" markdown report |
| `src/components/SnipePanel.tsx` | UI for launching a real-time snipe (SSE stream from `/api/resy-snipe`). Accepts `onLog` prop to forward events to the shared debug log |

### Lib

| File | Purpose |
|------|---------|
| `src/lib/logger.ts` | `LogEntry` type, `makeTs()`, `formatEntry()` — foundation for all structured logging |
| `src/lib/resyApi.ts` | Resy HTTP client: `fetchAvailability()`, `AvailabilitySlot` type |
| `src/lib/resyMonitor.ts` | `MonitoredRestaurant` config type + all 34 monitored restaurants with IDs, URLs, and booking window metadata |
| `src/lib/resyBooking.ts` | Low-level booking call: `bookReservation()` |
| `src/lib/emailTemplates.ts` | Email template helpers: `getNearestPreferredDay()`, `buildResyUrl()`, `getBookingContext()` |
| `src/lib/notifications.ts` | Multi-channel notification dispatch: email, Discord/Slack webhook, ntfy.sh push. Also exports `buildSmsEmail()` and `SMS_GATEWAYS` |
| `src/lib/scheduledSnipes.ts` | QStash-backed scheduled snipe CRUD |

### API Routes (`src/app/api/`)

All routes use structured `console.log` with `[Route] START/DONE/ERROR` pattern and `ms` timing.

| Route | Purpose |
|-------|---------|
| `resy-auth/route.ts` | Validate token, login with email/password, logout |
| `resy-monitor/route.ts` | Poll availability for a batch of restaurants; returns new slots |
| `resy-book/route.ts` | Book a specific reservation slot |
| `resy-snipe/route.ts` | SSE stream — polls aggressively until slot appears then books it |
| `send-email/route.ts` | Send email via Nodemailer (Gmail app password) |
| `calendar/route.ts` | Generate `.ics` calendar file for a reservation |
| `cron/route.ts` | QStash cron entrypoint for scheduled snipes |
| `scheduled-snipes/route.ts` | CRUD for scheduled snipe jobs (backed by Upstash Redis) |

## Logging System

Every log entry is a `LogEntry`:
```ts
{ ts: "14:32:01", level: "info" | "debug" | "warn" | "error" | "success", module: string, msg: string, data?: Record<string, unknown> }
```

`module` values: `poll`, `snipe`, `auth`, `book`, `email`, `ui`

The DebugPanel "Copy for Claude" button generates a full markdown diagnostic report including auth status, poll counters, WAF state, recent errors, and the last 100 log entries.

## Testing

```bash
src/__tests__/
  logger.test.ts         # makeTs() format, formatEntry() padding and data serialization
  notifications.test.ts  # buildSmsEmail() carrier formatting and edge cases
  restaurants.test.ts    # data integrity: unique IDs, required fields, valid venue IDs
  emailTemplates.test.ts # getNearestPreferredDay, buildResyUrl, getBookingContext urgency tiers
```

Run with `npm test`. All 39 tests must pass before merging.

## Key Invariants

- `resyVenueId` in `resyMonitor.ts` must be a valid numeric string — run `npm run verify:venues` after adding restaurants
- `advanceDays` in restaurant config = days before dining date when Resy opens booking (e.g., `28` = 4 weeks)
- WAF backoff triggers after 3 consecutive all-500 polls; resets on any success
- Auto-book restaurants are always included in every poll (tier1), monitor-only restaurants rotate in groups
- The debug log is client-side only; API route logs go to server stdout (Vercel function logs)

## Environment Variables

Required in `.env.local` or Vercel:
```
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

Gmail credentials are entered in-app (not env vars) and stored in `localStorage`.
