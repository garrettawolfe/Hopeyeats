import type { Restaurant } from "@/data/restaurants";

export interface UserSettings {
  name: string;
  email: string;
  gmailAppPassword: string;
  diningDateStart: string; // ISO date string
  diningDateEnd: string;
  partySize: number;
  specialRequests: string;
  preferredDays: string[]; // e.g. ["wednesday","thursday","friday","saturday"]
  diningTimeStart: string; // "18:30"
  diningTimeEnd: string;   // "21:30"
}

const DAY_NAMES = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];

/**
 * Given a target date and preferred day names, return the nearest date
 * on or after the target that falls on a preferred day.
 */
export function getNearestPreferredDay(from: Date, preferredDays: string[]): Date {
  const preferred = preferredDays
    .map((d) => DAY_NAMES.indexOf(d.toLowerCase()))
    .filter((n) => n >= 0);
  if (preferred.length === 0) return from;
  for (let i = 0; i <= 7; i++) {
    const candidate = new Date(from);
    candidate.setDate(from.getDate() + i);
    if (preferred.includes(candidate.getDay())) return candidate;
  }
  return from;
}

/**
 * Build a Resy URL with date + seats pre-filled, snapped to the nearest
 * preferred dining day on or after the target dining date.
 */
export function buildResyUrl(
  baseUrl: string,
  targetDiningDate: Date,
  partySize: number,
  preferredDays: string[]
): string {
  const date = getNearestPreferredDay(targetDiningDate, preferredDays);
  const dateStr = date.toISOString().split("T")[0];
  return `${baseUrl}?date=${dateStr}&seats=${partySize}`;
}

export interface EmailDraft {
  to: string;
  subject: string;
  body: string;
  isDirectToRestaurant: boolean;
}

export interface BookingContext {
  targetDiningDate: Date;
  bookingDate: Date;
  daysUntilBooking: number; // negative = past
  isActionable: boolean;
  urgencyLabel: string; // "Book Today at 9 AM ET", "Book in 3 days", "Book Apr 5", "Window Passed"
  urgencyTier: "today" | "soon" | "upcoming" | "past";
  targetDiningDateStr: string; // "Sat, Apr 5"
  bookingDateStr: string; // "Today" | "Tomorrow" | "Sat, Mar 29"
}

/**
 * Compute booking urgency relative to today.
 * If diningDateStart is set and in the future → use it as the target.
 * If not set → target = today + advanceDays (soonest bookable dining date).
 */
export function getBookingContext(
  advanceDays: number,
  bookingTime: string | null,
  diningDateStart: string
): BookingContext {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let targetDiningDate: Date;
  let bookingDate: Date;

  if (diningDateStart) {
    targetDiningDate = new Date(diningDateStart + "T00:00:00");
    bookingDate = new Date(targetDiningDate);
    bookingDate.setDate(targetDiningDate.getDate() - advanceDays);
  } else {
    // No dining date set: show soonest available = book today, dine in advanceDays
    targetDiningDate = new Date(today);
    targetDiningDate.setDate(today.getDate() + advanceDays);
    bookingDate = new Date(today);
  }

  const daysUntilBooking = Math.round(
    (bookingDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
  );
  const isActionable = daysUntilBooking >= 0;

  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
  };
  const targetDiningDateStr = targetDiningDate.toLocaleDateString("en-US", dateOpts);
  const bookingDateStr =
    daysUntilBooking === 0
      ? "Today"
      : daysUntilBooking === 1
      ? "Tomorrow"
      : bookingDate.toLocaleDateString("en-US", dateOpts);

  let urgencyLabel: string;
  let urgencyTier: "today" | "soon" | "upcoming" | "past";

  if (daysUntilBooking < 0) {
    urgencyLabel = "Window Passed";
    urgencyTier = "past";
  } else if (daysUntilBooking === 0) {
    urgencyLabel = bookingTime ? `Book Today at ${bookingTime}` : "Book Today";
    urgencyTier = "today";
  } else if (daysUntilBooking <= 6) {
    urgencyLabel = `Book in ${daysUntilBooking} day${daysUntilBooking === 1 ? "" : "s"}`;
    urgencyTier = "soon";
  } else {
    const dateStr = bookingDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    urgencyLabel = `Book ${dateStr}`;
    urgencyTier = "upcoming";
  }

  return {
    targetDiningDate,
    bookingDate,
    daysUntilBooking,
    isActionable,
    urgencyLabel,
    urgencyTier,
    targetDiningDateStr,
    bookingDateStr,
  };
}

function formatDateRange(start: string, end: string): string {
  const s = new Date(start + "T00:00:00");
  const e = new Date((end || start) + "T00:00:00");
  const opts: Intl.DateTimeFormatOptions = { month: "long", day: "numeric" };
  if (start === end || !end) return s.toLocaleDateString("en-US", opts);
  if (s.getMonth() === e.getMonth())
    return `${s.toLocaleDateString("en-US", { month: "long" })} ${s.getDate()}–${e.getDate()}`;
  return `${s.toLocaleDateString("en-US", opts)} – ${e.toLocaleDateString("en-US", opts)}`;
}

/** Generate a direct reservation-request email to a restaurant */
export function directEmail(
  restaurant: Restaurant,
  settings: UserSettings
): EmailDraft {
  const dateRange = settings.diningDateStart
    ? formatDateRange(settings.diningDateStart, settings.diningDateEnd || settings.diningDateStart)
    : "the coming weeks";
  const partyLabel =
    settings.partySize === 1 ? "1 guest" : `${settings.partySize} guests`;
  const specialBlock = settings.specialRequests
    ? `\n\nAdditional notes: ${settings.specialRequests}`
    : "";
  const target = restaurant.reservationEmail ?? restaurant.contactEmail ?? "";

  const body = `Hi ${restaurant.name} team,

I hope this finds you well! I'm reaching out to inquire about a reservation for ${partyLabel} sometime between ${dateRange}.

We're very much looking forward to experiencing your restaurant — it's been high on our list and we'd love to make it happen on this visit.${specialBlock}

If you have any availability during that window, please let me know what might work. I'm happy to be flexible on dates and times.

Thank you so much for your time, and I look forward to hearing from you.

Warm regards,
${settings.name}
${settings.email}`;

  return {
    to: target,
    subject: `Reservation Inquiry — ${partyLabel}, ${dateRange}`,
    body,
    isDirectToRestaurant: true,
  };
}

/** Generate a Resy reminder email sent to the user themselves */
export function selfReminderEmail(
  restaurant: Restaurant,
  settings: UserSettings
): EmailDraft {
  const ctx = getBookingContext(
    restaurant.advanceDays,
    restaurant.bookingTime,
    settings.diningDateStart
  );
  const timeLabel = restaurant.bookingTime ?? "as early as possible";
  const resyLink = restaurant.resyUrl ?? "https://resy.com";

  const dateTargetStr = settings.diningDateStart
    ? formatDateRange(
        settings.diningDateStart,
        settings.diningDateEnd || settings.diningDateStart
      )
    : ctx.targetDiningDateStr;

  const partyLabel =
    settings.partySize === 1 ? "1 guest" : `${settings.partySize} guests`;

  const bookingDateLabel =
    ctx.daysUntilBooking === 0
      ? `Today (${ctx.bookingDate.toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
        })}) at ${timeLabel}`
      : `${ctx.bookingDate.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
        })} at ${timeLabel}`;

  const body = `Hi${settings.name ? ` ${settings.name}` : ""},

This is your reminder to book ${restaurant.name} on Resy!

━━━━━━━━━━━━━━━━━━━━━━━━━━━
  WHEN TO LOG ON: ${bookingDateLabel}
  RESTAURANT:     ${restaurant.name}
  NEIGHBORHOOD:   ${restaurant.neighborhood}, ${restaurant.borough}
  YOUR TARGET:    ${dateTargetStr}${settings.partySize ? ` for ${partyLabel}` : ""}
━━━━━━━━━━━━━━━━━━━━━━━━━━━

Resy Link: ${resyLink}

Pro Tip: ${restaurant.bookingTip}

${restaurant.walkInOption ? `Walk-In Alternative: ${restaurant.walkInOption}` : ""}

Good luck!`;

  return {
    to: settings.email,
    subject: `Book ${restaurant.name} on Resy — ${ctx.bookingDateStr} at ${timeLabel}`,
    body: body.trim(),
    isDirectToRestaurant: false,
  };
}

export function generateEmail(
  restaurant: Restaurant,
  settings: UserSettings
): EmailDraft {
  const hasEmail =
    restaurant.reservationEmail !== null || restaurant.contactEmail !== null;
  if (hasEmail) return directEmail(restaurant, settings);
  return selfReminderEmail(restaurant, settings);
}
