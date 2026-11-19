#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { SessionManager } from "./client/auth.js";
import { registerPublicTools, registerAuthTools } from "./mcp/tools.js";
import { browserClient } from "./fallback/browserClient.js";

function log(...args: unknown[]): void {
  process.stderr.write("[wallapop-mcp] " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n");
}

async function main(): Promise<void> {
  const session = new SessionManager(config.sessionFile);
  session.load();

  const server = new McpServer({ name: "wallapop-mcp", version: "0.1.0" });
  registerPublicTools(server);

  const authenticated = session.isAuthenticated() || config.email !== undefined || config.password !== undefined;
  if (authenticated) {
    registerAuthTools(server, session);
    log("Authenticated tools enabled (favorites, saved searches)");
  } else {
    log("No credentials provided - only public tools enabled. Set WALLAPOP_EMAIL/WALLAPOP_PASSWORD for favorites.");
  }

  if (browserClient.isEnabled()) {
    log(`Browser fallback enabled (${config.browser})`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("wallapop-mcp server running over stdio");

  // Close Chrome whenever the MCP host goes away, so no orphaned browser keeps the profile locked.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const timer = setTimeout(() => process.exit(0), 5000);
    await browserClient.close().catch(() => void 0);
    clearTimeout(timer);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((err) => {
  process.stderr.write("[wallapop-mcp] fatal: " + (err instanceof Error ? err.stack : String(err)) + "\n");
  process.exit(1);
});