import type { Restaurant } from "@/data/restaurants";

export interface UserSettings {
  name: string;
  email: string;
  gmailAppPassword: string;
  diningDateStart: string; // ISO date string
  diningDateEnd: string;
  partySize: number;
  specialRequests: string;
}

export interface EmailDraft {
  to: string;
  subject: string;
  body: string;
  isDirectToRestaurant: boolean;
}

function formatDateRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const opts: Intl.DateTimeFormatOptions = { month: "long", day: "numeric" };
  if (start === end) return s.toLocaleDateString("en-US", opts);
  if (s.getMonth() === e.getMonth())
    return `${s.toLocaleDateString("en-US", { month: "long" })} ${s.getDate()}–${e.getDate()}`;
  return `${s.toLocaleDateString("en-US", opts)} – ${e.toLocaleDateString("en-US", opts)}`;
}

function formatBookingDate(
  diningDateStart: string,
  advanceDays: number
): { date: string; fullDate: string } {
  const target = new Date(diningDateStart);
  const booking = new Date(target);
  booking.setDate(target.getDate() - advanceDays);
  const full = booking.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const short = booking.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return { date: short, fullDate: full };
}

export function getBookingDate(
  diningDateStart: string,
  advanceDays: number
): { date: string; fullDate: string } {
  return formatBookingDate(diningDateStart, advanceDays);
}

/** Generate a direct reservation-request email to a restaurant */
export function directEmail(
  restaurant: Restaurant,
  settings: UserSettings
): EmailDraft {
  const dateRange = formatDateRange(
    settings.diningDateStart,
    settings.diningDateEnd
  );
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
  const { fullDate } = formatBookingDate(
    settings.diningDateStart,
    restaurant.advanceDays
  );
  const timeLabel = restaurant.bookingTime ?? "as early as possible";
  const dateRange = formatDateRange(
    settings.diningDateStart,
    settings.diningDateEnd
  );
  const resyLink = restaurant.resyUrl ?? "https://resy.com";

  const body = `Hi ${settings.name},

This is your reminder to book ${restaurant.name} on Resy!

━━━━━━━━━━━━━━━━━━━━━━━━━━━
  WHEN TO LOG ON: ${fullDate} at ${timeLabel}
  RESTAURANT:     ${restaurant.name}
  NEIGHBORHOOD:   ${restaurant.neighborhood}, ${restaurant.borough}
  YOUR TARGET:    ${dateRange} for ${settings.partySize} guests
━━━━━━━━━━━━━━━━━━━━━━━━━━━

Resy Link: ${resyLink}

Pro Tip: ${restaurant.bookingTip}

${restaurant.walkInOption ? `Walk-In Alternative: ${restaurant.walkInOption}` : ""}

Good luck!`;

  return {
    to: settings.email,
    subject: `Book ${restaurant.name} on Resy — ${fullDate} at ${timeLabel}`,
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
