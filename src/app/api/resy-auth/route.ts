import { NextResponse } from "next/server";
import { resyLogin, setAuthFromToken, getCachedAuth, clearCachedAuth } from "@/lib/resyBooking";

/**
 * POST /api/resy-auth
 * Login to Resy with email/password OR with a raw auth token.
 *
 * Body: { email, password }           — email/password login
 * Body: { authToken }                 — direct token auth (from Resy DevTools)
 * Body: { action: "logout" }          — clear auth
 */
export async function POST(request: Request) {
  try {
    const { email, password, authToken, action } = await request.json();

    if (action === "logout") {
      clearCachedAuth();
      return NextResponse.json({ authenticated: false });
    }

    // Option 1: Direct token auth (preferred — bypasses Resy's login bot protection)
    if (authToken) {
      console.log("[Auth] Validating raw auth token...");
      const result = await setAuthFromToken(authToken);

      if ("error" in result) {
        return NextResponse.json({ error: result.error }, { status: 401 });
      }

      return NextResponse.json({
        authenticated: true,
        firstName: result.firstName,
        lastName: result.lastName,
        email: result.email,
        hasPaymentMethod: result.paymentMethodId !== null,
      });
    }

    // Option 2: Email/password login (may fail — Resy blocks automated login)
    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password, or auth token required" },
        { status: 400 },
      );
    }

    console.log(`[Auth] Attempting email/password login for ${email}...`);
    const auth = await resyLogin(email, password);
    if (!auth) {
      return NextResponse.json(
        { error: "Login failed — Resy did not return an auth token. Try using your auth token instead." },
        { status: 401 },
      );
    }

    if ("error" in auth) {
      return NextResponse.json(
        { error: auth.error + " — Try using your auth token instead." },
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
