import test from "node:test";
import assert from "node:assert/strict";

import { memoize, dedupeAndRankSearchResults } from "./hybrid.js";

test("dedupeAndRankSearchResults prefers valid shippable items and removes duplicates", () => {
  const items = [
    { id: "1", title: "iPhone 13", price: 450, currency: "EUR", city: "Barcelona", shipping: { itemIsShippable: true, userAllowsShipping: true } },
    { id: "1", title: "iPhone 13 duplicate", price: 490, currency: "EUR", city: "Madrid", shipping: { itemIsShippable: true, userAllowsShipping: true } },
    { id: "2", title: "Broken iPhone", price: 10, currency: "EUR", reserved: true, shipping: { itemIsShippable: false, userAllowsShipping: false } },
  ];

  const ranked = dedupeAndRankSearchResults(items as any);

  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, "1");
  assert.equal(ranked[0].price, 450);
  assert.equal(ranked[1].id, "2");
});

test("memoize reuses fresh values for the same key", async () => {
  let calls = 0;
  const cached = memoize(
    async (value: string) => {
      calls += 1;
      return { value, calls };
    },
    { ttlMs: 1000 }
  );

  const first = await cached("abc");
  const second = await cached("abc");

  assert.deepEqual(first, { value: "abc", calls: 1 });
  assert.deepEqual(second, { value: "abc", calls: 1 });
  assert.equal(calls, 1);
});
