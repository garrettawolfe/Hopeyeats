/**
 * Run with: npm run verify:venues
 *
 * Two-phase venue ID verification:
 * 1. Validate existing IDs by hitting /4/find — 400 = bad ID, 200/500 = ID exists
 * 2. Try to resolve correct IDs via multiple API approaches
 */

const RESY_API_KEY = "VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5";
const RESY_LEGACY_KEY = "youarewhereyoueat";

const headers = {
  Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Origin: "https://resy.com",
  Referer: "https://resy.com/",
  "X-Origin": "https://resy.com",
};

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

/**
 * Phase 1: Check if a venue ID is valid by hitting /4/find.
 * - 200 = valid ID, has availability
 * - 500 = valid ID, server error (but ID exists)
 * - 400 = invalid/wrong ID
 * - 404 = ID doesn't exist
 */
async function validateVenueId(
  venueId: number
): Promise<{ valid: boolean; status: number; body: string }> {
  const date = tomorrow();
  const params = new URLSearchParams({
    venue_id: venueId.toString(),
    day: date,
    party_size: "2",
    lat: "40.7128",
    long: "-74.0060",
  });
  const res = await fetch(`https://api.resy.com/4/find?${params}`, {
    headers,
  });
  const body = await res.text().catch(() => "");
  return {
    valid: res.status === 200 || res.status === 500,
    status: res.status,
    body: body.slice(0, 200),
  };
}

/**
 * Phase 2: Try to resolve venue ID from slug using multiple approaches.
 */
async function resolveFromSlug(slug: string): Promise<number | null> {
  // Approach 1: /3/venue with url_slug + location
  for (const locParam of ["location", "location_id"]) {
    for (const key of [RESY_API_KEY, RESY_LEGACY_KEY]) {
      const params = new URLSearchParams({ url_slug: slug, [locParam]: "1" });
      try {
        const res = await fetch(`https://api.resy.com/3/venue?${params}`, {
          headers: {
            ...headers,
            Authorization: `ResyAPI api_key="${key}"`,
          },
        });
        if (res.ok) {
          const data = await res.json();
          const id = data?.id?.resy;
          if (id) return id;
        }
      } catch {}
    }
  }

  // Approach 2: /2/venue with url_slug
  try {
    const params = new URLSearchParams({ url_slug: slug });
    const res = await fetch(`https://api.resy.com/2/venue?${params}`, {
      headers,
    });
    if (res.ok) {
      const data = await res.json();
      const id = data?.id?.resy ?? data?.venue?.id?.resy;
      if (id) return id;
    }
  } catch {}

  // Approach 3: Search for the venue name
  try {
    const searchName = slug.replace(/-/g, " ");
    const params = new URLSearchParams({
      query: searchName,
      geo: '{"latitude":40.7128,"longitude":-74.006}',
      types: '["venue"]',
    });
    const res = await fetch(`https://api.resy.com/3/venuesearch/search?${params}`, {
      headers,
    });
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

async function main() {
  const { restaurants } = await import("../src/data/restaurants");

  console.log("Phase 1: Validating existing venue IDs via /4/find...\n");

  const invalid: { name: string; slug: string; id: number; status: number; body: string }[] = [];
  const valid: { name: string; id: number }[] = [];

  for (const r of restaurants) {
    if (!r.resyUrl || !r.resyVenueId) continue;

    const slug = r.resyUrl.split("/venues/")[1] ?? "";
    process.stdout.write(`  ${r.name} (${r.resyVenueId})... `);

    const result = await validateVenueId(r.resyVenueId);

    if (result.valid) {
      console.log(`✅ valid (${result.status})`);
      valid.push({ name: r.name, id: r.resyVenueId });
    } else {
      console.log(`❌ INVALID (${result.status}) ${result.body.slice(0, 100)}`);
      invalid.push({ name: r.name, slug, id: r.resyVenueId, status: result.status, body: result.body });
    }

    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Valid: ${valid.length}, Invalid: ${invalid.length}`);

  if (invalid.length === 0) {
    console.log("\nAll venue IDs are valid! 🎉");
    return;
  }

  console.log(`\nPhase 2: Trying to resolve correct IDs for ${invalid.length} invalid venues...\n`);

  const fixes: { name: string; slug: string; oldId: number; newId: number }[] = [];

  for (const inv of invalid) {
    process.stdout.write(`  Resolving ${inv.name} (slug: ${inv.slug})... `);
    const newId = await resolveFromSlug(inv.slug);
    if (newId) {
      console.log(`✅ found: ${newId}`);
      fixes.push({ name: inv.name, slug: inv.slug, oldId: inv.id, newId });
    } else {
      console.log(`❌ could not resolve`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (fixes.length > 0) {
    console.log(`\n${"=".repeat(60)}`);
    console.log("FIXES NEEDED in src/data/restaurants.ts:\n");
    for (const f of fixes) {
      console.log(`  ${f.name}: ${f.oldId} → ${f.newId}`);
    }
  }

  if (invalid.length > fixes.length) {
    const unresolved = invalid.filter(
      (inv) => !fixes.some((f) => f.slug === inv.slug)
    );
    console.log("\nCould not auto-resolve these (check manually on resy.com):");
    for (const u of unresolved) {
      console.log(`  ${u.name}: https://resy.com/cities/new-york-ny/venues/${u.slug}`);
    }
    console.log(
      "\nTip: Open each URL in Chrome, then check DevTools Network tab"
    );
    console.log('for API calls containing "venue_id" in the request params.');
  }
}

main().catch(console.error);
