#!/usr/bin/env node

import { config } from "../src/config.js";
import { hybrid } from "../src/hybrid.js";
import { browserClient } from "../src/fallback/browserClient.js";

async function main(): Promise<void> {
  const health = {
    ok: true,
    server: "wallapop-mcp",
    version: "0.1.0",
    browserFallback: browserClient.isEnabled(),
    sessionFile: config.sessionFile,
    defaultLocation: {
      latitude: config.defaultLat,
      longitude: config.defaultLng,
      distanceKm: config.defaultDistanceKm,
    },
    auth: {
      configured: Boolean(config.email || config.password),
      sessionPresent: Boolean(config.sessionFile),
    },
  };

  try {
    const probe = await hybrid.search({
      keywords: "iphone",
      maxResults: 1,
      distanceKm: config.defaultDistanceKm,
    });
    health.ok = probe.data.items.length >= 0;
    health.lastSearch = {
      source: probe.source,
      total: probe.data.total ?? probe.data.items.length,
      itemCount: probe.data.items.length,
    };
  } catch (err) {
    health.ok = false;
    health.lastSearch = {
      error: err instanceof Error ? err.message : String(err),
    };
  }

  console.log(JSON.stringify(health, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }, null, 2));
  process.exit(1);
});
