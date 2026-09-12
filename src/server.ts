import { spawn, type ChildProcess } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DapClient, type JsonObject } from "./dap-client.js";

const jsonObject = z.record(z.string(), z.unknown());
const timeout = z.number().int().positive().max(300_000).default(10_000);

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("DAP arguments must be a JSON object");
  }
  return value as JsonObject;
}

export interface DolphinDapServer {
  server: McpServer;
  client: DapClient;
  close(): Promise<void>;
}

export function createServer(): DolphinDapServer {
  const server = new McpServer({ name: "dolphin-dap-mcp", version: "0.1.0" });
  const client = new DapClient();
  let dolphin: ChildProcess | undefined;
  let dolphinError: Error | undefined;

  server.registerTool(
    "dolphin_start",
    {
      description: "Start Dolphin with an ELF, optional disc and source roots, then connect its DAP server.",
      inputSchema: {
        executable: z.string().min(1),
        elf: z.string().min(1),
        disc: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535).default(5678),
        sourcePaths: z.array(z.string().min(1)).max(64).default([]),
        headless: z.boolean().default(false),
        stopOnEntry: z.boolean().default(false),
        timeoutMs: timeout,
      },
    },
    async ({ executable, elf, disc, port, sourcePaths, headless, stopOnEntry, timeoutMs }) => {
      if (dolphin !== undefined && dolphin.exitCode === null) {
        throw new Error("Dolphin is already running under this MCP server");
      }
      dolphinError = undefined;
      const args = ["-C", `Dolphin.General.DAPPort=${port}`];
      if (disc !== undefined) {
        args.push(
          "-C",
          `Dolphin.Core.DefaultISO=${disc}`,
          "-C",
          "Dolphin.Core.BootExecutableWithDefaultDisc=true",
        );
      }
      if (sourcePaths.length > 0) {
        args.push("-C", `Dolphin.Debug.SourcePaths=${sourcePaths.join(";")}`);
      }
      args.push("--exec", elf);
      if (headless) args.push("--platform", "headless");
      dolphin = spawn(executable, args, { stdio: "ignore" });
      dolphin.once("error", (error) => {
        dolphinError = error;
      });
      dolphin.once("exit", () => {
        client.close();
        dolphin = undefined;
      });

      const deadline = Date.now() + timeoutMs;
      let lastError: unknown;
      while (Date.now() < deadline) {
        if (dolphinError !== undefined) throw dolphinError;
        if (dolphin.exitCode !== null) {
          throw new Error(`Dolphin exited with code ${dolphin.exitCode}`);
        }
        try {
          await client.connect({ host: "127.0.0.1", port, timeoutMs: 500 });
          const state = await client.configureLifecycle("attach", stopOnEntry, timeoutMs);
          return result({ pid: dolphin.pid, args, dap: client.status, state });
        } catch (error) {
          lastError = error;
          client.close();
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      dolphin.kill("SIGTERM");
      throw new Error(`Dolphin did not expose DAP within ${timeoutMs} ms: ${String(lastError)}`);
    },
  );

  server.registerTool(
    "dolphin_connect",
    {
      description: "Connect and initialize an existing Dolphin DAP server.",
      inputSchema: {
        host: z.string().default("127.0.0.1"),
        port: z.number().int().min(1).max(65535).default(5678),
        socketPath: z.string().optional(),
        lifecycle: z.enum(["none", "attach", "launch"]).default("attach"),
        stopOnEntry: z.boolean().default(false),
        timeoutMs: timeout,
      },
    },
    async ({ host, port, socketPath, lifecycle, stopOnEntry, timeoutMs }) => {
      const status = await client.connect({
        host,
        port,
        ...(socketPath === undefined ? {} : { socketPath }),
        timeoutMs,
      });
      const state =
        lifecycle === "none"
          ? null
          : await client.configureLifecycle(lifecycle, stopOnEntry, timeoutMs);
      return result({ status, state });
    },
  );

  server.registerTool(
    "dolphin_disconnect",
    {
      description: "Disconnect DAP and optionally terminate a Dolphin process started by this server.",
      inputSchema: { terminateDolphin: z.boolean().default(false) },
    },
    async ({ terminateDolphin }) => {
      await client.disconnect();
      if (terminateDolphin && dolphin !== undefined && dolphin.exitCode === null) {
        dolphin.kill("SIGTERM");
      }
      return result({ disconnected: true, dolphinTerminated: terminateDolphin });
    },
  );

  server.registerTool(
    "dolphin_status",
    {
      description: "Show DAP connection state, capabilities, queued events, and managed Dolphin PID.",
      inputSchema: {},
    },
    async () => result({ ...client.status, dolphinPid: dolphin?.pid ?? null }),
  );

  server.registerTool(
    "dolphin_request",
    {
      description: "Send any standard or Dolphin-specific DAP request. This is the complete protocol escape hatch.",
      inputSchema: {
        command: z.string().min(1),
        arguments: jsonObject.default({}),
        awaitEvent: z.string().min(1).optional(),
        timeoutMs: timeout,
      },
    },
    async ({ command, arguments: argumentsValue, awaitEvent, timeoutMs }) => {
      const eventPromise =
        awaitEvent === undefined ? undefined : client.waitForEvent(awaitEvent, timeoutMs);
      const response = await client.request(command, argumentsValue, timeoutMs);
      const event = eventPromise === undefined ? null : await eventPromise;
      return result({ response, event });
    },
  );

  server.registerTool(
    "dolphin_events",
    {
      description: "Drain queued asynchronous DAP events, or wait for one named event.",
      inputSchema: {
        waitFor: z.string().min(1).optional(),
        timeoutMs: timeout,
      },
    },
    async ({ waitFor, timeoutMs }) =>
      result(waitFor === undefined ? client.drainEvents() : await client.waitForEvent(waitFor, timeoutMs)),
  );

  server.registerTool(
    "dolphin_execution",
    {
      description: "Pause, continue, step, restart, terminate, or inspect Dolphin's PPC execution state.",
      inputSchema: {
        action: z.enum(["pause", "continue", "next", "stepIn", "stepOut", "restart", "terminate", "threads"]),
        granularity: z.enum(["statement", "line", "instruction"]).optional(),
        awaitState: z.boolean().default(true),
        timeoutMs: timeout,
      },
    },
    async ({ action, granularity, awaitState, timeoutMs }) => {
      const emitsState = action !== "threads" && action !== "terminate";
      const eventPromise =
        awaitState && emitsState
          ? client.waitForEvent(undefined, timeoutMs, (event) =>
              event.event === "stopped" || event.event === "continued",
            )
          : undefined;
      const args: JsonObject = action === "restart" || action === "terminate" || action === "threads"
        ? {}
        : { threadId: 1, ...(granularity === undefined ? {} : { granularity }) };
      const response = await client.request(action, args, timeoutMs);
      return result({ response, event: eventPromise === undefined ? null : await eventPromise });
    },
  );

  server.registerTool(
    "dolphin_breakpoints",
    {
      description: "Replace source, instruction, or data breakpoints using native DAP argument shapes.",
      inputSchema: {
        kind: z.enum(["source", "instruction", "data"]),
        source: jsonObject.optional(),
        breakpoints: z.array(jsonObject).default([]),
        timeoutMs: timeout,
      },
    },
    async ({ kind, source, breakpoints, timeoutMs }) => {
      const command = {
        source: "setBreakpoints",
        instruction: "setInstructionBreakpoints",
        data: "setDataBreakpoints",
      }[kind];
      const args: JsonObject = {
        breakpoints,
        ...(kind === "source" ? { source: source ?? {} } : {}),
      };
      return result(await client.request(command, args, timeoutMs));
    },
  );

  server.registerTool(
    "dolphin_stack",
    {
      description: "Get the PPC call stack with DWARF source paths and lines when available.",
      inputSchema: {
        startFrame: z.number().int().nonnegative().default(0),
        levels: z.number().int().nonnegative().max(1000).default(50),
        timeoutMs: timeout,
      },
    },
    async ({ startFrame, levels, timeoutMs }) =>
      result(await client.request("stackTrace", { threadId: 1, startFrame, levels }, timeoutMs)),
  );

  server.registerTool(
    "dolphin_variables",
    {
      description: "Inspect scopes/variables, set a register, or evaluate a PPC debugger expression.",
      inputSchema: {
        action: z.enum(["scopes", "variables", "set", "evaluate"]),
        frameId: z.number().int().nonnegative().default(0),
        variablesReference: z.number().int().nonnegative().optional(),
        name: z.string().optional(),
        value: z.string().optional(),
        expression: z.string().optional(),
        timeoutMs: timeout,
      },
    },
    async ({ action, frameId, variablesReference, name, value, expression, timeoutMs }) => {
      let command: string;
      let args: JsonObject;
      if (action === "scopes") {
        command = "scopes";
        args = { frameId };
      } else if (action === "variables") {
        if (variablesReference === undefined) throw new Error("variablesReference is required");
        command = "variables";
        args = { variablesReference };
      } else if (action === "set") {
        if (variablesReference === undefined || name === undefined || value === undefined) {
          throw new Error("variablesReference, name, and value are required");
        }
        command = "setVariable";
        args = { variablesReference, name, value };
      } else {
        if (expression === undefined) throw new Error("expression is required");
        command = "evaluate";
        args = { expression, frameId, context: "repl" };
      }
      return result(await client.request(command, args, timeoutMs));
    },
  );

  server.registerTool(
    "dolphin_memory",
    {
      description: "Read or write emulated memory. Reads return both base64 and hexadecimal data.",
      inputSchema: {
        action: z.enum(["read", "write"]),
        address: z.string().min(1),
        count: z.number().int().nonnegative().max(1_048_576).optional(),
        offset: z.number().int().default(0),
        data: z.string().optional(),
        encoding: z.enum(["hex", "base64", "utf8"]).default("hex"),
        allowPartial: z.boolean().default(false),
        timeoutMs: timeout,
      },
    },
    async ({ action, address, count, offset, data, encoding, allowPartial, timeoutMs }) => {
      if (action === "read") {
        if (count === undefined) throw new Error("count is required for reads");
        const response = await client.request(
          "readMemory",
          { memoryReference: address, offset, count },
          timeoutMs,
        );
        const encoded = typeof response.body?.data === "string" ? response.body.data : "";
        return result({ response, hex: Buffer.from(encoded, "base64").toString("hex") });
      }
      if (data === undefined) throw new Error("data is required for writes");
      const bytes = Buffer.from(data, encoding === "utf8" ? "utf8" : encoding);
      return result(
        await client.request(
          "writeMemory",
          { memoryReference: address, offset, data: bytes.toString("base64"), allowPartial },
          timeoutMs,
        ),
      );
    },
  );

  server.registerTool(
    "dolphin_disassemble",
    {
      description: "Disassemble PPC instructions around an emulated address.",
      inputSchema: {
        address: z.string().min(1),
        byteOffset: z.number().int().default(0),
        instructionOffset: z.number().int().default(0),
        instructionCount: z.number().int().min(1).max(65_536).default(32),
        timeoutMs: timeout,
      },
    },
    async ({ address, byteOffset, instructionOffset, instructionCount, timeoutMs }) =>
      result(
        await client.request(
          "disassemble",
          {
            memoryReference: address,
            offset: byteOffset,
            instructionOffset,
            instructionCount,
          },
          timeoutMs,
        ),
      ),
  );

  server.registerTool(
    "dolphin_sources",
    {
      description: "List loaded sources, fetch source text, or query valid breakpoint lines.",
      inputSchema: {
        action: z.enum(["list", "read", "breakpointLocations"]),
        arguments: jsonObject.default({}),
        timeoutMs: timeout,
      },
    },
    async ({ action, arguments: argumentsValue, timeoutMs }) => {
      const command = {
        list: "loadedSources",
        read: "source",
        breakpointLocations: "breakpointLocations",
      }[action];
      return result(await client.request(command, argumentsValue, timeoutMs));
    },
  );

  server.registerTool(
    "dolphin_watch",
    {
      description: "Create/cancel realtime watches or freeze/unfreeze emulated memory.",
      inputSchema: {
        action: z.enum(["watch", "cancel", "freeze", "unfreeze"]),
        arguments: jsonObject,
        timeoutMs: timeout,
      },
    },
    async ({ action, arguments: argumentsValue, timeoutMs }) => {
      const command = {
        watch: "dolphin_realtimeWatch",
        cancel: "dolphin_realtimeWatchCancel",
        freeze: "dolphin_freeze",
        unfreeze: "dolphin_unfreeze",
      }[action];
      return result(await client.request(command, argumentsValue, timeoutMs));
    },
  );

  server.registerTool(
    "dolphin_scan",
    {
      description: "Start, refine, inspect, cancel, dispose, undo, or filter a Dolphin memory scan.",
      inputSchema: {
        action: z.enum(["start", "refine", "status", "results", "cancel", "dispose", "undo", "removeResults"]),
        arguments: jsonObject,
        awaitCompletion: z.boolean().default(false),
        timeoutMs: timeout,
      },
    },
    async ({ action, arguments: argumentsValue, awaitCompletion, timeoutMs }) => {
      const suffix = {
        start: "Start",
        refine: "Refine",
        status: "Status",
        results: "Results",
        cancel: "Cancel",
        dispose: "Dispose",
        undo: "Undo",
        removeResults: "RemoveResults",
      }[action];
      const command = `dolphin_memoryScan${suffix}`;
      const response = await client.request(command, argumentsValue, timeoutMs);
      if (!awaitCompletion || (action !== "start" && action !== "refine")) return result(response);
      const scanId = response.body?.scanId;
      const jobId = response.body?.jobId;
      const event = await client.waitForEvent(undefined, timeoutMs, (candidate) => {
        if (!candidate.event.startsWith("dolphin_memoryScan")) return false;
        return candidate.body?.scanId === scanId && candidate.body?.jobId === jobId;
      });
      return result({ response, event });
    },
  );

  server.registerTool(
    "dolphin_code",
    {
      description: "Find free memory, inject raw PPC code, create a detour, or resolve a pointer chain.",
      inputSchema: {
        action: z.enum(["findFreeMemory", "injectCode", "detour", "resolvePointerChain", "memoryRegions"]),
        arguments: jsonObject.default({}),
        timeoutMs: timeout,
      },
    },
    async ({ action, arguments: argumentsValue, timeoutMs }) => {
      const command = {
        findFreeMemory: "dolphin_findFreeMemory",
        injectCode: "dolphin_injectCode",
        detour: "dolphin_detour",
        resolvePointerChain: "dolphin_resolvePointerChain",
        memoryRegions: "dolphin_memoryRegions",
      }[action];
      return result(await client.request(command, asObject(argumentsValue), timeoutMs));
    },
  );

  return {
    server,
    client,
    async close() {
      await client.disconnect();
      if (dolphin !== undefined && dolphin.exitCode === null) dolphin.kill("SIGTERM");
      await server.close();
    },
  };
}
