# Dolphin DAP MCP

An MCP server for controlling and inspecting Dolphin through its Debug Adapter
Protocol server. It keeps one persistent DAP connection, correlates responses by
`request_seq`, queues asynchronous events, and exposes both task-oriented tools
and a raw request escape hatch.

## Requirements

- Node.js 22 or newer
- A Dolphin build with the DAP server enabled
- An ELF with debug information for source-level debugging

For `doldecomp/melee`, configure debug builds with:

```sh
python3 configure.py --debug --sym on --map --no-optimize
ninja
```

`--map` is useful for offline address inspection but is not required by DAP.
`--sym on` and Dolphin source roots are required for useful source mappings.

## Install

```sh
npm install
npm run check
```

## OpenCode

Add the server to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "dolphin-dap": {
      "type": "local",
      "command": [
        "node",
        "/home/jbarber/projects/ai/yolo/livemindio/dolphin-dap-mcp/dist/src/index.js"
      ],
      "enabled": true
    }
  }
}
```

Run `npm run build` after changing the MCP server.

## Dolphin

The `dolphin_start` tool starts Dolphin and connects DAP in one operation. An
equivalent manual launch is:

```sh
/path/to/dolphin-emu-nogui \
  -C Dolphin.General.DAPPort=5678 \
  -C Dolphin.Debug.SourcePaths=/project/src\;/project/extern/dolphin/src \
  -C Dolphin.Core.DefaultISO=/path/to/game.iso \
  -C Dolphin.Core.BootExecutableWithDefaultDisc=true \
  --exec /project/build/GALE01/main.elf
```

Use `dolphin_connect` instead when Dolphin is already running. Unix-domain DAP
sockets are supported through `socketPath`.

## Tools

- `dolphin_start`: launch Dolphin, connect DAP, and complete its lifecycle
- `dolphin_connect`: connect to an existing TCP or Unix-socket DAP server
- `dolphin_disconnect`: disconnect and optionally stop a managed Dolphin
- `dolphin_status`: inspect the connection, capabilities, and event queue
- `dolphin_request`: send any standard or Dolphin-specific DAP request
- `dolphin_events`: drain events or wait for a named event
- `dolphin_execution`: pause, continue, step, restart, terminate, or list threads
- `dolphin_breakpoints`: manage source, instruction, and data breakpoints
- `dolphin_stack`: obtain a DWARF-aware PPC call stack
- `dolphin_variables`: inspect scopes/variables, set registers, and evaluate
- `dolphin_memory`: read or write memory using hex, base64, or UTF-8 payloads
- `dolphin_disassemble`: disassemble PPC instructions around an address
- `dolphin_sources`: list/read sources and query breakpoint locations
- `dolphin_watch`: manage realtime watches and frozen memory
- `dolphin_scan`: run and refine asynchronous memory scans
- `dolphin_code`: find memory, inject code, detour, and resolve pointer chains

`dolphin_request` intentionally exposes the complete protocol so new Dolphin DAP
extensions remain usable without an MCP release.

## Operational Notes

- Dolphin permits at most two DAP clients and debugger state is global. Prefer
  one MCP connection at a time.
- Breakpoint setter requests are authoritative within their respective domains.
- Data breakpoints clear active memory freezes.
- Variable handles become stale whenever execution resumes or scopes refresh.
- Wait for `stopped`, `continued`, and memory-scan terminal events rather than
  treating a successful command response as proof that the state changed.
- Code injection, detours, register mutation, and memory writes modify live
  emulation state and should be used deliberately.
