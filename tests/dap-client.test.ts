import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { DapClient, type JsonObject } from "../src/dap-client.js";

function frame(message: JsonObject): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

function parseRequests(socket: net.Socket, handler: (request: JsonObject) => void): void {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
    while (true) {
      const separator = buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const match = /^Content-Length: (\d+)$/.exec(buffer.subarray(0, separator).toString());
      assert.notEqual(match, null);
      const length = Number(match![1]);
      const start = separator + 4;
      if (buffer.length < start + length) return;
      const request = JSON.parse(buffer.subarray(start, start + length).toString()) as JsonObject;
      buffer = buffer.subarray(start + length);
      handler(request);
    }
  });
}

async function fakeDap(
  onRequest?: (socket: net.Socket, request: JsonObject) => void,
): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((socket) => {
    parseRequests(socket, (request) => {
      if (request.command === "initialize") {
        const response = frame({
          seq: 1,
          type: "response",
          request_seq: request.seq,
          command: "initialize",
          success: true,
          body: { supportsReadMemoryRequest: true },
        });
        const event = frame({ seq: 2, type: "event", event: "initialized", body: {} });
        const combined = Buffer.concat([response, event]);
        socket.write(combined.subarray(0, 17));
        socket.write(combined.subarray(17));
        return;
      }
      onRequest?.(socket, request);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fake DAP did not bind a TCP address");
  }
  return { server, port: address.port };
}

test("parses fragmented and coalesced handshake frames", async (t) => {
  const fake = await fakeDap();
  t.after(() => fake.server.close());
  const client = new DapClient();
  t.after(() => client.close());

  const status = await client.connect({ port: fake.port });
  assert.equal(status.connected, true);
  assert.deepEqual(status.capabilities, { supportsReadMemoryRequest: true });
});

test("correlates out-of-order responses by request_seq", async (t) => {
  const held: JsonObject[] = [];
  const fake = await fakeDap((socket, request) => {
    held.push(request);
    if (held.length !== 2) return;
    for (const item of held.toReversed()) {
      socket.write(
        frame({
          seq: 10 + Number(item.seq),
          type: "response",
          request_seq: item.seq,
          command: item.command,
          success: true,
          body: { marker: item.command },
        }),
      );
    }
  });
  t.after(() => fake.server.close());
  const client = new DapClient();
  t.after(() => client.close());
  await client.connect({ port: fake.port });

  const [first, second] = await Promise.all([
    client.request("first"),
    client.request("second"),
  ]);
  assert.equal(first.body?.marker, "first");
  assert.equal(second.body?.marker, "second");
});

test("surfaces body-less DAP errors", async (t) => {
  const fake = await fakeDap((socket, request) => {
    socket.write(
      frame({
        seq: 4,
        type: "response",
        request_seq: request.seq,
        command: request.command,
        success: false,
        message: "unsupported",
      }),
    );
  });
  t.after(() => fake.server.close());
  const client = new DapClient();
  t.after(() => client.close());
  await client.connect({ port: fake.port });

  await assert.rejects(client.request("unknown"), /DAP unknown failed: unsupported/);
});

test("event waiters honor names and predicates", async (t) => {
  const fake = await fakeDap((socket, request) => {
    socket.write(
      frame({
        seq: 5,
        type: "response",
        request_seq: request.seq,
        command: request.command,
        success: true,
        body: {},
      }),
    );
    socket.write(
      frame({ seq: 6, type: "event", event: "stopped", body: { reason: "pause" } }),
    );
    socket.write(
      frame({ seq: 7, type: "event", event: "stopped", body: { reason: "breakpoint" } }),
    );
  });
  t.after(() => fake.server.close());
  const client = new DapClient();
  t.after(() => client.close());
  await client.connect({ port: fake.port });

  const eventPromise = client.waitForEvent(
    "stopped",
    1_000,
    (event) => event.body?.reason === "breakpoint",
  );
  await client.request("continue");
  const event = await eventPromise;
  assert.equal(event.body?.reason, "breakpoint");
  assert.equal(client.drainEvents()[0]?.body?.reason, "pause");
});
