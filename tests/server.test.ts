import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/server.js";

test("registers the complete Dolphin DAP tool surface", async (t) => {
  const app = createServer();
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await app.close();
  });

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.deepEqual(names.sort(), [
    "dolphin_breakpoints",
    "dolphin_code",
    "dolphin_connect",
    "dolphin_disassemble",
    "dolphin_disconnect",
    "dolphin_events",
    "dolphin_execution",
    "dolphin_memory",
    "dolphin_request",
    "dolphin_scan",
    "dolphin_sources",
    "dolphin_stack",
    "dolphin_start",
    "dolphin_status",
    "dolphin_variables",
    "dolphin_watch",
  ]);

  const status = await client.callTool({ name: "dolphin_status", arguments: {} });
  assert.equal(status.isError, undefined);
  assert.match(JSON.stringify(status.structuredContent), /"connected":false/);
});
