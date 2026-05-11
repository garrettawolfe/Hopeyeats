import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    const { to, subject, body, gmailUser, gmailAppPassword } =
      await req.json();

    console.log("[Email] START", { to, subject: subject?.slice(0, 60) });

    if (!to || !subject || !body) {
      console.warn("[Email] MISSING_FIELDS", { to: !!to, subject: !!subject, body: !!body });
      return NextResponse.json(
        { success: false, message: "Missing required fields: to, subject, body" },
        { status: 400 }
      );
    }

    const user = gmailUser || process.env.GMAIL_USER;
    const pass = gmailAppPassword || process.env.GMAIL_APP_PASSWORD;

    if (!user || !pass) {
      console.warn("[Email] NO_CREDENTIALS");
      return NextResponse.json(
        {
          success: false,
          message:
            "Gmail credentials not configured. Add GMAIL_USER and GMAIL_APP_PASSWORD to .env.local, or enter them in Settings.",
        },
        { status: 400 }
      );
    }

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user, pass },
    });

    await transporter.sendMail({
      from: `"${user}" <${user}>`,
      to,
      subject,
      text: body,
    });

    console.log("[Email] SENT", { ms: Date.now() - t0, to });
    return NextResponse.json({ success: true, message: "Email sent!" });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error occurred";
    console.error("[Email] ERROR", { ms: Date.now() - t0, error: message });
    return NextResponse.json(
      { success: false, message: `Failed to send email: ${message}` },
      { status: 500 }
    );
  }
}
