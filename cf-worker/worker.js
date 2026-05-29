/**
 * Cloudflare Worker — Resy Notify Relay
 *
 * Proxies POST requests to api.resy.com/3/notify from Cloudflare's edge IPs,
 * which may have better reputation with Imperva than Vercel datacenter IPs.
 *
 * Deploy:
 *   cd cf-worker
 *   npx wrangler deploy
 *
 * Set secret:
 *   npx wrangler secret put RELAY_SECRET
 *   (then set RESY_RELAY_URL + RESY_RELAY_SECRET in Vercel env vars)
 *
 * Request body (JSON):
 *   { headers: Record<string,string>, body: string, secret: string }
 *
 * Response: proxied Resy response (status + body forwarded as-is)
 */

const RESY_NOTIFY_URL = "https://api.resy.com/3/notify";

export default {
  async fetch(request, env) {
    // Only accept POST
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { headers, body, secret } = payload;

    // Shared secret check — prevents abuse of the relay
    if (!env.RELAY_SECRET || secret !== env.RELAY_SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!headers || !body) {
      return new Response(JSON.stringify({ error: "headers and body required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const resyRes = await fetch(RESY_NOTIFY_URL, {
        method: "POST",
        headers,
        body,
      });

      const resyBody = await resyRes.text();

      return new Response(
        JSON.stringify({
          status: resyRes.status,
          ok: resyRes.ok,
          body: resyBody,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: String(err) }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  },
};
