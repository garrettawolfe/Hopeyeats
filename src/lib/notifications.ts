/**
 * Notification service for the Resy Reservation Monitor.
 *
 * Supports three free channels:
 * 1. Email (via existing Gmail/Nodemailer integration)
 *    - Also supports carrier SMS gateways (e.g., 5551234567@vtext.com)
 * 2. Webhook (Discord, Slack, or any URL that accepts POST JSON)
 * 3. ntfy.sh (free push notifications — no account needed)
 *
 * All channels are optional and independently configurable.
 */

import type { AvailabilitySlot } from "./resyApi";
import type { MonitoredRestaurant } from "./resyMonitor";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface NotificationConfig {
  email?: {
    enabled: boolean;
    to: string; // email address or carrier-sms gateway (e.g., 5551234567@vtext.com)
    gmailUser: string;
    gmailAppPassword: string;
  };
  webhook?: {
    enabled: boolean;
    url: string; // Discord or Slack webhook URL
    type: "discord" | "slack" | "generic";
  };
  ntfy?: {
    enabled: boolean;
    topic: string; // e.g., "hopeyeats-alerts" — subscribe via ntfy.sh/hopeyeats-alerts
    server?: string; // defaults to https://ntfy.sh
  };
}

// SMS gateway suffixes for major US carriers
export const SMS_GATEWAYS: Record<string, string> = {
  verizon: "vtext.com",
  att: "txt.att.net",
  tmobile: "tmomail.net",
  sprint: "messaging.sprintpcs.com",
  uscellular: "email.uscc.net",
  cricket: "sms.cricketwireless.net",
  boost: "sms.myboostmobile.com",
  metro: "mymetropcs.com",
};

export function buildSmsEmail(phone: string, carrier: string): string {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return "";
  const gateway = SMS_GATEWAYS[carrier.toLowerCase()];
  if (!gateway) return "";
  return `${digits}@${gateway}`;
}

// ─── Message Formatting ─────────────────────────────────────────────────────

interface SlotAlert {
  restaurant: MonitoredRestaurant;
  newSlots: AvailabilitySlot[];
}

function formatTime12(time24: string): string {
  if (!time24) return "";
  const [h, m] = time24.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Plain text format for email/SMS. */
function formatPlainText(alerts: SlotAlert[]): { subject: string; body: string } {
  const totalNew = alerts.reduce((sum, a) => sum + a.newSlots.length, 0);
  const restaurantNames = alerts.map((a) => a.restaurant.name).join(", ");

  const subject = `Resy Alert: ${totalNew} new slot${totalNew !== 1 ? "s" : ""} at ${restaurantNames}`;

  const lines: string[] = [
    `${totalNew} NEW RESERVATION${totalNew !== 1 ? "S" : ""} FOUND`,
    "",
  ];

  for (const alert of alerts) {
    lines.push(`━━━ ${alert.restaurant.name} ━━━`);
    for (const slot of alert.newSlots) {
      lines.push(
        `  ${formatDate(slot.date)} at ${formatTime12(slot.time)} — ${slot.tableType} (${slot.minParty}-${slot.maxParty}p)`,
      );
      lines.push(`  Book: ${slot.resyUrl}`);
    }
    lines.push("");
  }

  lines.push("— HopeYeats Monitor");

  return { subject, body: lines.join("\n") };
}

/** Short SMS-friendly format (under 160 chars per slot). */
function formatSms(alerts: SlotAlert[]): string {
  const parts: string[] = [];
  for (const alert of alerts) {
    for (const slot of alert.newSlots) {
      parts.push(
        `${alert.restaurant.name}: ${formatDate(slot.date)} ${formatTime12(slot.time)} ${slot.resyUrl}`,
      );
    }
  }
  // Truncate to keep reasonable SMS length
  return parts.slice(0, 5).join("\n");
}

/** Discord webhook embed format. */
function formatDiscord(alerts: SlotAlert[]): object {
  const totalNew = alerts.reduce((sum, a) => sum + a.newSlots.length, 0);

  const embeds = alerts.map((alert) => ({
    title: `${alert.restaurant.name} — ${alert.newSlots.length} new slot${alert.newSlots.length !== 1 ? "s" : ""}`,
    color: 0x22c55e, // green
    fields: alert.newSlots.slice(0, 10).map((slot) => ({
      name: `${formatDate(slot.date)} at ${formatTime12(slot.time)}`,
      value: `${slot.tableType} (${slot.minParty}-${slot.maxParty}p)\n[Book on Resy](${slot.resyUrl})`,
      inline: true,
    })),
    timestamp: new Date().toISOString(),
  }));

  return {
    content: `**${totalNew} new Resy slot${totalNew !== 1 ? "s" : ""} found!**`,
    embeds: embeds.slice(0, 10), // Discord limit
  };
}

/** Slack webhook block format. */
function formatSlack(alerts: SlotAlert[]): object {
  const totalNew = alerts.reduce((sum, a) => sum + a.newSlots.length, 0);

  const blocks: object[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${totalNew} New Resy Slot${totalNew !== 1 ? "s" : ""} Found`,
      },
    },
  ];

  for (const alert of alerts) {
    const slotLines = alert.newSlots
      .slice(0, 10)
      .map(
        (slot) =>
          `• *${formatDate(slot.date)}* at ${formatTime12(slot.time)} — ${slot.tableType} (<${slot.resyUrl}|Book>)`,
      );

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${alert.restaurant.name}*\n${slotLines.join("\n")}`,
      },
    });
  }

  return { blocks };
}

// ─── Notification Dispatch ───────────────────────────────────────────────────

/** Send email notification via the existing /api/send-email endpoint. */
async function sendEmail(
  config: NonNullable<NotificationConfig["email"]>,
  alerts: SlotAlert[],
  baseUrl: string,
): Promise<boolean> {
  const { subject, body } = formatPlainText(alerts);

  try {
    const res = await fetch(`${baseUrl}/api/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: config.to,
        subject,
        body,
        gmailUser: config.gmailUser,
        gmailAppPassword: config.gmailAppPassword,
      }),
    });
    const data = await res.json();
    if (!data.success) {
      console.error("[Notify] Email failed:", data.message);
      return false;
    }
    console.log(`[Notify] Email sent to ${config.to}`);
    return true;
  } catch (err) {
    console.error("[Notify] Email error:", err);
    return false;
  }
}

/** Send webhook notification (Discord, Slack, or generic POST). */
async function sendWebhook(
  config: NonNullable<NotificationConfig["webhook"]>,
  alerts: SlotAlert[],
): Promise<boolean> {
  let payload: object;

  switch (config.type) {
    case "discord":
      payload = formatDiscord(alerts);
      break;
    case "slack":
      payload = formatSlack(alerts);
      break;
    default:
      // Generic webhook — send plain structure
      payload = {
        event: "new_slots",
        timestamp: new Date().toISOString(),
        alerts: alerts.map((a) => ({
          restaurant: a.restaurant.name,
          venueId: a.restaurant.resyVenueId,
          newSlots: a.newSlots.map((s) => ({
            date: s.date,
            time: s.time,
            tableType: s.tableType,
            partySize: `${s.minParty}-${s.maxParty}`,
            bookUrl: s.resyUrl,
          })),
        })),
      };
  }

  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[Notify] Webhook failed: ${res.status}`);
      return false;
    }
    console.log(`[Notify] Webhook sent to ${config.type}`);
    return true;
  } catch (err) {
    console.error("[Notify] Webhook error:", err);
    return false;
  }
}

/** Send push notification via ntfy.sh (free, no account needed). */
async function sendNtfy(
  config: NonNullable<NotificationConfig["ntfy"]>,
  alerts: SlotAlert[],
): Promise<boolean> {
  const server = config.server || "https://ntfy.sh";
  const totalNew = alerts.reduce((sum, a) => sum + a.newSlots.length, 0);
  const restaurantNames = alerts.map((a) => a.restaurant.name).join(", ");

  // ntfy supports a simple POST with headers for title/priority
  const firstSlot = alerts[0]?.newSlots[0];
  const clickUrl = firstSlot?.resyUrl || "https://resy.com";

  try {
    const res = await fetch(`${server}/${config.topic}`, {
      method: "POST",
      headers: {
        Title: `${totalNew} New Resy Slot${totalNew !== 1 ? "s" : ""}`,
        Priority: totalNew >= 3 ? "high" : "default",
        Tags: "fork_and_knife,sparkles",
        Click: clickUrl,
      },
      body: formatSms(alerts),
    });
    if (!res.ok) {
      console.error(`[Notify] ntfy failed: ${res.status}`);
      return false;
    }
    console.log(`[Notify] ntfy push sent to ${config.topic}`);
    return true;
  } catch (err) {
    console.error("[Notify] ntfy error:", err);
    return false;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Send notifications for new slot alerts across all configured channels.
 * Only sends if there are actual new slots to report.
 */
export async function sendNotifications(
  config: NotificationConfig,
  alerts: SlotAlert[],
  baseUrl: string,
): Promise<{ sent: string[]; failed: string[] }> {
  // Filter to only alerts with new slots
  const activeAlerts = alerts.filter((a) => a.newSlots.length > 0);
  if (activeAlerts.length === 0) {
    return { sent: [], failed: [] };
  }

  const sent: string[] = [];
  const failed: string[] = [];

  // Send all channels in parallel
  const promises: Promise<void>[] = [];

  if (config.email?.enabled) {
    promises.push(
      sendEmail(config.email, activeAlerts, baseUrl).then((ok) => {
        (ok ? sent : failed).push("email");
      }),
    );
  }

  if (config.webhook?.enabled) {
    promises.push(
      sendWebhook(config.webhook, activeAlerts).then((ok) => {
        (ok ? sent : failed).push(`webhook:${config.webhook!.type}`);
      }),
    );
  }

  if (config.ntfy?.enabled) {
    promises.push(
      sendNtfy(config.ntfy, activeAlerts).then((ok) => {
        (ok ? sent : failed).push("ntfy");
      }),
    );
  }

  await Promise.all(promises);

  return { sent, failed };
}
