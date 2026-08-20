import { hybrid } from "../src/hybrid.js";
import { config } from "../src/config.js";

async function main(): Promise<void> {
  console.log("== smoke test ==");
  console.log("default location:", config.defaultLat, config.defaultLng);

  const search = await hybrid.search({ keywords: "iphone 15", maxResults: 5, distanceKm: 50 });
  console.log("\n== search ==\n", "source:", search.source, "total:", search.data.total);
  for (const item of search.data.items.slice(0, 3)) {
    console.log("-", item.id, "|", item.title, "|", item.price, item.currency, "|", item.city, "|", item.url);
  }
  console.log("nextPage:", search.data.nextPage ? "yes" : "no", "| count:", search.data.items.length);

  const first = search.data.items[0];
  if (first) {
    const listing = await hybrid.listing(first.id);
    console.log("\n== listing", first.id, "==\n", "source:", listing.source);
    console.log("title:", listing.data.title, "| price:", listing.data.price, "| condition:", listing.data.condition);
    console.log("city:", listing.data.location?.city, "| views:", listing.data.views, "| favorites:", listing.data.favorites);
    console.log("images:", listing.data.images.length, "| seller:", listing.data.sellerId);

    if (listing.data.sellerId) {
      const seller = await hybrid.seller(listing.data.sellerId);
      console.log("\n== seller ==\n", "source:", seller.source);
      console.log("name:", seller.data.microName, "| type:", seller.data.type, "| rating:", seller.data.ratings?.reviews);
      console.log("city:", seller.data.location?.city, "| registerDate:", seller.data.registerDate, "| published:", seller.data.publishedItemsCount);
    }
  }

  const cats = await hybrid.categories();
  console.log("\n== categories ==\n", "source:", cats.source, "| count:", cats.data.length);
  console.log(cats.data.slice(0, 5).map((c) => `${c.categoryId}: ${c.title}`).join("\n"));
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});