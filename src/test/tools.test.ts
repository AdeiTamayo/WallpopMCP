import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { registerPublicTools, registerAuthTools } from "./mcp/tools.js";
import { SessionManager } from "./client/auth.js";

const EXPECTED_TOOLS = [
  "server_status",
  "search_products",
  "get_listing",
  "get_seller",
  "list_categories",
  "scan_products",
  "refresh_session",
  "get_saved_searches",
  "create_saved_search",
  "delete_saved_search",
  "favorite_listing",
  "unfavorite_listing",
  "list_conversations",
  "get_messages",
  "send_message",
  "make_offer",
];

interface ToolInfo {
  name: string;
  annotations?: ToolAnnotations;
}

async function buildToolList(): Promise<ToolInfo[]> {
  const server = new McpServer({ name: "wallapop-mcp-test", version: "0.0.0" });
  const session = new SessionManager("unused-session-path.json");
  registerPublicTools(server);
  registerAuthTools(server, session);
  const client = new Client({ name: "wallapop-mcp-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.listTools();
    return res.tools as unknown as ToolInfo[];
  } finally {
    await client.close().catch(() => void 0);
    await server.close().catch(() => void 0);
  }
}

function assertCompleteAnnotations(tool: ToolInfo): void {
  const a = tool.annotations ?? {};
  for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
    assert.equal(
      typeof a[hint],
      "boolean",
      `tool '${tool.name}' is missing boolean hint '${hint}'`
    );
  }
}

test("all expected tools are registered", async () => {
  const tools = await buildToolList();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
});

test("every tool declares all four annotation hints", async () => {
  const tools = await buildToolList();
  for (const tool of tools) {
    assertCompleteAnnotations(tool);
  }
});

test("read-only tools are annotated read-only and writers are not", async () => {
  const tools = await buildToolList();
  const byName = new Map(tools.map((t) => [t.name, t]));

  for (const name of ["server_status", "search_products", "get_listing", "get_seller", "list_categories", "scan_products", "get_saved_searches", "list_conversations", "get_messages"]) {
    assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, `${name} should be read-only`);
  }

  for (const name of ["create_saved_search", "send_message", "make_offer"]) {
    const a = byName.get(name)?.annotations;
    assert.equal(a?.readOnlyHint, false, `${name} should not be read-only`);
    assert.equal(a?.idempotentHint, false, `${name} should not be idempotent`);
  }

  assert.equal(byName.get("delete_saved_search")?.annotations?.destructiveHint, true);
  assert.equal(byName.get("server_status")?.annotations?.openWorldHint, false);
});
