# Dolphin DAP MCP

An MCP server for controlling and inspecting Dolphin through Dolphin's Debug
Adapter Protocol (DAP) server.

It provides tools for:

- Starting Dolphin or connecting to an existing Dolphin process
- Controlling execution and managing breakpoints
- Inspecting stack frames, variables, registers, sources, and PPC instructions
- Reading, writing, watching, freezing, and scanning emulated memory
- Injecting PPC code, creating detours, and resolving pointer chains
- Sending arbitrary standard or Dolphin-specific DAP requests

## Requirements

- Node.js 22 or newer
- A Dolphin build with the DAP server enabled
- An ELF with debug information for source-level debugging

## Install

```sh
npm install
npm run build
```

## Configure an MCP Client

Configure the client to run the compiled server over stdio. For OpenCode, add
this entry to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "dolphin-dap": {
      "type": "local",
      "command": [
        "node",
        "/path/to/dolphin-dap-mcp/dist/src/index.js"
      ],
      "enabled": true
    }
  }
}
```

Run `npm run build` after changing the server source.

## Connect to Dolphin

### Start Dolphin Through MCP

Call `dolphin_start` to start Dolphin, open its TCP DAP server, connect, and
initialize the debug session:

```json
{
  "executable": "/path/to/dolphin-emu-nogui",
  "elf": "/path/to/project/build/main.elf",
  "disc": "/path/to/game.iso",
  "port": 5678,
  "sourcePaths": [
    "/path/to/project/src",
    "/path/to/dolphin/src"
  ],
  "headless": false,
  "stopOnEntry": true
}
```

`disc` is optional. `port` defaults to `5678`; `sourcePaths` defaults to an
empty array; `headless` and `stopOnEntry` default to `false`.

Core debugging must also be enabled. `dolphin_start` does not currently pass
`-C Dolphin.Interface.DebugModeEnabled=True` or accept arbitrary CLI arguments.
For MCP-managed launches, set this in the `Dolphin.ini` used by Dolphin:

```ini
[Interface]
DebugModeEnabled = True
```

Alternatively, launch Dolphin yourself with the explicit CLI override below and
use `dolphin_connect`.

### Connect to an Existing Dolphin Process

Start Dolphin with `-C Dolphin.Interface.DebugModeEnabled=True` and either
`Dolphin.General.DAPPort` or `Dolphin.General.DAPSocket` configured, then call
`dolphin_connect`. For example:

```sh
dolphin-emu-nogui \
  -C Dolphin.Interface.DebugModeEnabled=True \
  -C Dolphin.General.DAPPort=5678 \
  --exec /path/to/game.iso \
  --platform headless
```

The core-debugging override enables breakpoint checks and debugger-aware stepping
for this launch without opening GUI panes in NoGUI. A DAP listener alone does not
enable it. Keep the override when switching to a Unix socket. For source-level
debugging, also configure a matching debug ELF as described in the
[server guide](https://github.com/LiveMindIO/dolphin-dap/blob/master/Tools/dap/README.md#running-the-server).

TCP example:

```json
{
  "host": "127.0.0.1",
  "port": 5678,
  "lifecycle": "attach",
  "stopOnEntry": true
}
```

Unix socket example:

```json
{
  "socketPath": "/path/to/dolphin-dap.sock",
  "lifecycle": "attach",
  "stopOnEntry": true
}
```

`lifecycle` accepts `attach`, `launch`, or `none`. Use `none` when Dolphin's DAP
lifecycle has already been initialized by another client.

Call `dolphin_disconnect` to close the DAP connection. Set
`terminateDolphin` to `true` to also stop a Dolphin process launched by
`dolphin_start`.

## Tools

| Tool | Functionality |
| --- | --- |
| `dolphin_start` | Start Dolphin with an ELF and optional disc, connect over TCP, and initialize DAP. |
| `dolphin_connect` | Connect to an existing TCP or Unix-socket DAP server and optionally initialize its lifecycle. |
| `dolphin_disconnect` | Disconnect DAP and optionally terminate the Dolphin process started by this server. |
| `dolphin_status` | Return connection state, DAP capabilities, queued event count, and managed Dolphin PID. |
| `dolphin_request` | Send any standard or Dolphin-specific DAP request and optionally wait for an event. |
| `dolphin_events` | Drain queued asynchronous events or wait for a named event. |
| `dolphin_execution` | Pause, continue, step in, step out, step over, restart, terminate, or list threads. |
| `dolphin_breakpoints` | Replace source, instruction, or data breakpoints using native DAP argument shapes. |
| `dolphin_stack` | Return the PPC call stack with DWARF source paths and line information when available. |
| `dolphin_variables` | Inspect scopes and variables, set a register or variable, or evaluate an expression. |
| `dolphin_memory` | Read or write emulated memory using hexadecimal, base64, or UTF-8 data. |
| `dolphin_disassemble` | Disassemble PPC instructions around an emulated address. |
| `dolphin_sources` | List loaded sources, read source text, or query valid breakpoint locations. |
| `dolphin_watch` | Create or cancel realtime watches and freeze or unfreeze emulated memory. |
| `dolphin_scan` | Start, refine, inspect, cancel, dispose, undo, or filter an asynchronous memory scan. |
| `dolphin_code` | List memory regions, find free memory, inject PPC code, create a detour, or resolve a pointer chain. |

All tools that communicate with Dolphin accept an optional `timeoutMs`. The
default is 10,000 ms and the maximum is 300,000 ms.

## Usage Examples

Pause execution:

```json
{
  "action": "pause"
}
```

Read 32 bytes of emulated memory:

```json
{
  "action": "read",
  "address": "0x80000000",
  "count": 32
}
```

Set an instruction breakpoint:

```json
{
  "kind": "instruction",
  "breakpoints": [
    {
      "instructionReference": "0x80001234"
    }
  ]
}
```

Send a DAP request not covered by a dedicated tool:

```json
{
  "command": "modules",
  "arguments": {}
}
```

Wait for a stop event:

```json
{
  "waitFor": "stopped",
  "timeoutMs": 30000
}
```

## Runtime Behavior

- The server maintains one persistent DAP connection and correlates responses
  by DAP request sequence.
- Asynchronous DAP events remain queued until consumed by a tool waiting for
  them or by `dolphin_events`.
- Dolphin supports at most two DAP clients, and debugger state is global.
- Breakpoint setter requests replace the breakpoints in their respective
  source, instruction, or data domain.
- Setting data breakpoints clears active memory freezes.
- Variable handles become invalid after execution resumes or scopes refresh.
- Execution and memory-scan operations can complete asynchronously. Use their
  event-waiting options or `dolphin_events` to confirm the resulting state.
- Memory writes, register changes, freezes, code injection, and detours modify
  live emulation state.
