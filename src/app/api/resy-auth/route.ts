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

    const auth = await resyLogin(email, password);
    if (!auth) {
      return NextResponse.json(
        { error: "Login failed — check your Resy email and password" },
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
