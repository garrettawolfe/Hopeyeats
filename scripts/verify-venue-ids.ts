/**
 * Run with: npx tsx scripts/verify-venue-ids.ts
 *
 * Checks each restaurant's venue ID against the Resy API.
 * Reports mismatches and missing IDs.
 */

const RESY_API_KEY = "VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5";

interface VenueCheck {
  name: string;
  slug: string;
  ourId: number | null;
  actualId: number | null;
  match: boolean;
  error?: string;
}

async function resolveVenueId(slug: string): Promise<number | null> {
  try {
    const params = new URLSearchParams({ url_slug: slug, location: "1" });
    const res = await fetch(
      `https://api.resy.com/3/venue?${params}`,
      {
        headers: {
          Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
          Accept: "application/json",
        },
      }
    );
    if (!res.ok) {
      console.error(`  [${res.status}] for slug "${slug}"`);
      return null;
    }
    const data = await res.json();
    return data?.id?.resy ?? null;
  } catch (err) {
    console.error(`  Error for "${slug}":`, err);
    return null;
  }
}

async function main() {
  // Import restaurants
  const { restaurants } = await import("../src/data/restaurants");

  const results: VenueCheck[] = [];

  for (const r of restaurants) {
    if (!r.resyUrl) continue;

    // Extract slug from URL
    const slug = r.resyUrl.split("/venues/")[1];
    if (!slug) {
      console.log(`⚠ ${r.name}: could not extract slug from ${r.resyUrl}`);
      continue;
    }

    console.log(`Checking ${r.name} (slug: ${slug}, our ID: ${r.resyVenueId})...`);

    const actualId = await resolveVenueId(slug);

    const match = r.resyVenueId === actualId;
    results.push({
      name: r.name,
      slug,
      ourId: r.resyVenueId,
      actualId,
      match,
    });

    if (!match) {
      console.log(
        `  ❌ MISMATCH: our ID = ${r.resyVenueId}, actual = ${actualId}`
      );
    } else {
      console.log(`  ✅ ID ${actualId} is correct`);
    }

    // Small delay between requests
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));

  const mismatches = results.filter((r) => !r.match);
  const correct = results.filter((r) => r.match);

  console.log(`✅ Correct: ${correct.length}`);
  console.log(`❌ Mismatches: ${mismatches.length}`);

  if (mismatches.length > 0) {
    console.log("\nMISMATCHES:");
    for (const m of mismatches) {
      console.log(`  ${m.name}: our ID = ${m.ourId}, actual = ${m.actualId} (slug: ${m.slug})`);
    }

    console.log("\nCopy-paste fix for restaurants.ts:");
    for (const m of mismatches) {
      if (m.actualId) {
        console.log(`  "${m.name}": resyVenueId: ${m.actualId},`);
      }
    }
  }
}

main().catch(console.error);
