import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";

export async function POST(req: NextRequest) {
  try {
    const { to, subject, body, gmailUser, gmailAppPassword } =
      await req.json();

    if (!to || !subject || !body) {
      return NextResponse.json(
        { success: false, message: "Missing required fields: to, subject, body" },
        { status: 400 }
      );
    }

    const user = gmailUser || process.env.GMAIL_USER;
    const pass = gmailAppPassword || process.env.GMAIL_APP_PASSWORD;

    if (!user || !pass) {
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

    return NextResponse.json({ success: true, message: "Email sent!" });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error occurred";
    return NextResponse.json(
      { success: false, message: `Failed to send email: ${message}` },
      { status: 500 }
    );
  }
}
