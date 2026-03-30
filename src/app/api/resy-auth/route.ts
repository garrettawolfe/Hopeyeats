import { NextResponse } from "next/server";
import { resyLogin, getCachedAuth, clearCachedAuth } from "@/lib/resyBooking";

/**
 * POST /api/resy-auth
 * Login to Resy with email/password. Returns auth status (not the raw token).
 */
export async function POST(request: Request) {
  try {
    const { email, password, action } = await request.json();

    if (action === "logout") {
      clearCachedAuth();
      return NextResponse.json({ authenticated: false });
    }

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password required" },
        { status: 400 },
      );
    }

    console.log(`[Auth] Attempting login for ${email}...`);
    const auth = await resyLogin(email, password);
    if (!auth) {
      console.error(`[Auth] Login returned null for ${email}`);
      return NextResponse.json(
        { error: "Login failed — Resy did not return an auth token. Check your credentials." },
        { status: 401 },
      );
    }

    if ("error" in auth) {
      console.error(`[Auth] Login error for ${email}:`, auth.error);
      return NextResponse.json(
        { error: auth.error },
        { status: 401 },
      );
    }

    return NextResponse.json({
      authenticated: true,
      firstName: auth.firstName,
      lastName: auth.lastName,
      email: auth.email,
      hasPaymentMethod: auth.paymentMethodId !== null,
    });
  } catch (err) {
    console.error("[Auth] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Auth error" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/resy-auth
 * Check current auth status.
 */
export async function GET() {
  const auth = getCachedAuth();
  if (!auth) {
    return NextResponse.json({ authenticated: false });
  }

  return NextResponse.json({
    authenticated: true,
    firstName: auth.firstName,
    lastName: auth.lastName,
    email: auth.email,
    hasPaymentMethod: auth.paymentMethodId !== null,
  });
}
