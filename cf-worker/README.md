# Resy Notify Relay — Cloudflare Worker

Routes POST requests to `api.resy.com/3/notify` through Cloudflare's edge network,
which may have better IP reputation with Imperva than Vercel datacenter IPs.

## Deploy

```bash
cd cf-worker
npx wrangler login         # one-time auth
npx wrangler deploy        # deploys to *.workers.dev
```

## Set the shared secret

```bash
npx wrangler secret put RELAY_SECRET
# enter any strong random string, e.g.: openssl rand -hex 32
```

## Wire up Vercel

Add to Vercel environment variables:
- `RESY_RELAY_URL` = `https://resy-notify-relay.<your-subdomain>.workers.dev`
- `RESY_RELAY_SECRET` = the same secret you set above

The notify route will automatically route through the Worker when these are set,
and fall back to a direct request if the Worker is unreachable.

## Test

```bash
curl -X POST https://resy-notify-relay.<your-subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"secret":"your-secret","headers":{"Content-Type":"application/x-www-form-urlencoded"},"body":"test=1"}'
```

Expected: `{"status":400,...}` or similar from Resy (not 502 = Imperva block bypassed).
If you still get `{"status":502,...}` in the body, Imperva is also blocking Cloudflare IPs.
