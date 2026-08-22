import test from "node:test";
import assert from "node:assert/strict";

import { evaluateOfferTarget } from "./client/chat.js";

const DONOSTI = { pickupLat: 43.3214, pickupLng: -1.9853, pickupRadiusKm: 8 };

test("evaluateOfferTarget: shippable item -> ship cost added (protection 8% + shipping 3 EUR)", () => {
  const ev = evaluateOfferTarget(470, {
    shippable: true,
    itemLat: 41.61,
    itemLng: 0.626,
    ...DONOSTI,
    protectionPct: 8,
    shippingFeeEur: 3,
  });
  assert.equal(ev.ok, true);
  assert.equal(ev.shippable, true);
  assert.equal(ev.pickupOk, false);
  assert.ok((ev.pickupDistanceKm ?? 0) > 250);
  assert.equal(ev.breakdown.protection, 37.6);
  assert.equal(ev.breakdown.shipping, 3);
  assert.equal(ev.breakdown.total, 510.6);
  assert.equal(ev.estimatedTotal, 510.6);
});

test("evaluateOfferTarget: in-person-only listing far from pickup -> blocked", () => {
  const ev = evaluateOfferTarget(420, {
    shippable: false,
    itemLat: 36.6203,
    itemLng: -4.4992,
    ...DONOSTI,
  });
  assert.equal(ev.ok, false);
  assert.equal(ev.pickupOk, false);
  assert.match(ev.reason ?? "", /no Wallapop shipping/);
});

test("evaluateOfferTarget: in-person-only listing inside pickup radius -> ok, no ship fees", () => {
  const ev = evaluateOfferTarget(300, {
    shippable: false,
    itemLat: 43.3169,
    itemLng: -1.9843,
    ...DONOSTI,
  });
  assert.equal(ev.ok, true);
  assert.equal(ev.pickupOk, true);
  assert.equal(ev.breakdown.protection, 0);
  assert.equal(ev.breakdown.shipping, 0);
  assert.equal(ev.breakdown.total, 300);
});