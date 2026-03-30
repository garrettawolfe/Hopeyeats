/**
 * Run with: npm run verify:venues
 *
 * Validates every restaurant's venue ID against the Resy API.
 * Uses /4/find with real NYC coordinates to check if each ID is valid.
 * Then tries to resolve correct IDs for any that fail.
 */

const RESY_API_KEY = "VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5";

const headers: Record<string, string> = {
  Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Origin: "https://resy.com",
  Referer: "https://resy.com/",
};

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7); // check a week out to avoid same-day closures
  return d.toISOString().split("T")[0];
}

// ── Phase 1: Validate venue ID via /4/find ──────────────────────────────────

async function validateVenueId(
  venueId: number,
): Promise<{ valid: boolean; status: number; body: string; slots: number }> {
  const date = tomorrow();
  const params = new URLSearchParams({
    venue_id: venueId.toString(),
    day: date,
    party_size: "2",
    lat: "40.7128",
    long: "-74.0060",
  });

  const res = await fetch(`https://api.resy.com/4/find?${params}`, { headers });
  const body = await res.text().catch(() => "");

  let slots = 0;
  if (res.status === 200) {
    try {
      const data = JSON.parse(body);
      slots = data?.results?.venues?.[0]?.slots?.length ?? 0;
    } catch {}
  }

  return {
    valid: res.status === 200 || res.status === 500,
    status: res.status,
    body: body.slice(0, 200),
    slots,
  };
}

// ── Phase 2: Resolve venue ID from slug ─────────────────────────────────────

async function resolveFromSlug(slug: string): Promise<number | null> {
  // Try /3/venue with both param names
  for (const locParam of ["location", "location_id"]) {
    const params = new URLSearchParams({ url_slug: slug, [locParam]: "1" });
    try {
      const res = await fetch(`https://api.resy.com/3/venue?${params}`, { headers });
      if (res.ok) {
        const data = await res.json();
        const id = data?.id?.resy;
        if (id) return id;
      }
    } catch {}
  }

  // Try search
  try {
    const searchName = slug.replace(/-/g, " ");
    const params = new URLSearchParams({
      query: searchName,
      geo: '{"latitude":40.7128,"longitude":-74.006}',
      types: '["venue"]',
    });
    const res = await fetch(
      `https://api.resy.com/3/venuesearch/search?${params}`,
      { headers },
    );
    if (res.ok) {
      const data = await res.json();
      const hits = data?.search?.hits ?? [];
      for (const hit of hits) {
        const hitSlug = hit?.url_slug ?? "";
        if (hitSlug === slug || hitSlug.includes(slug)) {
          return hit?.id?.resy ?? null;
        }
      }
    }
  } catch {}

  return null;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { restaurants } = await import("../src/data/restaurants");
  const resyRestaurants = restaurants.filter(
    (r) => r.resyUrl && r.resyVenueId,
  );

  console.log(
    `\nVerifying ${resyRestaurants.length} venue IDs against Resy API...\n`,
  );

  const results: {
    name: string;
    slug: string;
    id: number;
    valid: boolean;
    status: number;
    slots: number;
    body: string;
  }[] = [];

  for (const r of resyRestaurants) {
    const slug = r.resyUrl!.split("/venues/")[1] ?? "";
    process.stdout.write(`  ${r.name} (${r.resyVenueId})... `);

    const result = await validateVenueId(r.resyVenueId!);
    results.push({
      name: r.name,
      slug,
      id: r.resyVenueId!,
      ...result,
    });

    if (result.valid) {
      const slotInfo = result.slots > 0 ? ` (${result.slots} slots)` : "";
      console.log(`✅ ${result.status}${slotInfo}`);
    } else {
      console.log(`❌ ${result.status} — ${result.body.slice(0, 120)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  // ── Summary ──
  const valid = results.filter((r) => r.valid);
  const invalid = results.filter((r) => !r.valid);
  const withSlots = results.filter((r) => r.slots > 0);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ✅ Valid: ${valid.length}/${results.length}`);
  console.log(`  ❌ Invalid: ${invalid.length}`);
  console.log(
    `  🍽  With availability: ${withSlots.length} (${withSlots.map((r) => r.name).join(", ") || "none"})`,
  );
  console.log(`${"═".repeat(60)}`);

  if (invalid.length === 0) {
    console.log("\nAll venue IDs are valid!\n");
    return;
  }

  // ── Phase 2: resolve invalid IDs ──
  console.log(
    `\nTrying to resolve correct IDs for ${invalid.length} invalid venues...\n`,
  );

  const fixes: { name: string; slug: string; oldId: number; newId: number }[] =
    [];

  for (const inv of invalid) {
    process.stdout.write(`  ${inv.name} (${inv.slug})... `);
    const newId = await resolveFromSlug(inv.slug);
    if (newId && newId !== inv.id) {
      console.log(`→ ${newId} (was ${inv.id})`);
      fixes.push({
        name: inv.name,
        slug: inv.slug,
        oldId: inv.id,
        newId,
      });
    } else if (newId && newId === inv.id) {
      console.log(`ID ${inv.id} is correct (API hiccup?)`);
    } else {
      console.log("could not resolve");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (fixes.length > 0) {
    console.log(`\n${"═".repeat(60)}`);
    console.log("  FIXES NEEDED in src/data/restaurants.ts:\n");
    for (const f of fixes) {
      console.log(`    ${f.name}: resyVenueId: ${f.oldId} → ${f.newId}`);
    }
    console.log(`${"═".repeat(60)}`);
  }

  const unresolved = invalid.filter(
    (inv) => !fixes.some((f) => f.slug === inv.slug),
  );
  if (unresolved.length > 0) {
    console.log("\n  Check these manually on resy.com:");
    for (const u of unresolved) {
      console.log(
        `    ${u.name}: https://resy.com/cities/new-york-ny/venues/${u.slug}`,
      );
    }
    console.log(
      "\n  Tip: Open in Chrome → DevTools → Network → filter for 'find' → check venue_id param\n",
    );
  }
}

main().catch(console.error);
