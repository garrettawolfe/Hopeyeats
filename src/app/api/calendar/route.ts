import { NextRequest, NextResponse } from "next/server";

// Build a minimal valid .ics file manually — no external dep needed
function buildIcs(params: {
  summary: string;
  description: string;
  dtstart: Date;
  dtalarm: number; // minutes before to alert
  uid: string;
}): string {
  function fmt(d: Date) {
    return d
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
  }

  const now = new Date();
  const end = new Date(params.dtstart.getTime() + 30 * 60 * 1000); // 30-min block

  // Sanitize description for ICS (replace newlines with \n literal)
  const desc = params.description.replace(/\n/g, "\\n").replace(/,/g, "\\,");

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HopeYeats//Restaurant Booking Reminder//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${params.uid}@hopeyeats`,
    `DTSTAMP:${fmt(now)}`,
    `DTSTART:${fmt(params.dtstart)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${params.summary}`,
    `DESCRIPTION:${desc}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${params.summary}`,
    `TRIGGER:-PT${params.dtalarm}M`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

export async function POST(req: NextRequest) {
  try {
    const { restaurantId, restaurantName, bookingDate, bookingTime, resyUrl, tip } =
      await req.json();

    if (!restaurantName || !bookingDate) {
      return NextResponse.json(
        { success: false, message: "Missing restaurantName or bookingDate" },
        { status: 400 }
      );
    }

    // Parse booking date + time into a Date object
    // bookingDate: "2026-04-01", bookingTime: "9:00 AM ET"
    const [year, month, day] = bookingDate.split("-").map(Number);

    let hour = 9;
    let minute = 0;
    if (bookingTime) {
      const timeMatch = bookingTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (timeMatch) {
        hour = parseInt(timeMatch[1]);
        minute = parseInt(timeMatch[2]);
        if (timeMatch[3].toUpperCase() === "PM" && hour !== 12) hour += 12;
        if (timeMatch[3].toUpperCase() === "AM" && hour === 12) hour = 0;
      }
    }

    // Create as UTC — user's calendar app will interpret in their local tz
    // We target ET (UTC-5 in winter, UTC-4 in summer) — offset 5 hours
    const dtstart = new Date(
      Date.UTC(year, month - 1, day, hour + 5, minute, 0)
    );

    const description = [
      `Log on to Resy to book ${restaurantName}!`,
      resyUrl ? `Resy link: ${resyUrl}` : "",
      tip ? `Tip: ${tip}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const ics = buildIcs({
      summary: `Book ${restaurantName} on Resy NOW`,
      description,
      dtstart,
      dtalarm: 15,
      uid: `${restaurantId}-${bookingDate}`,
    });

    return new NextResponse(ics, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="${restaurantId}-booking-reminder.ics"`,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { success: false, message },
      { status: 500 }
    );
  }
}
