<p align="center">
  <img src="./logo.svg" alt="OpenCode Autopilot" width="720">
</p>

# OpenCode Autopilot

OpenCode Autopilot is a Phase 1 plugin prototype for an autonomous `auto` mode. It keeps OpenCode moving between turns, classifies tool-call risk, routes risky actions through an LLM judge interface, detects loops, and writes an audit trail.

## Status

This repository currently implements the Phase 1 plugin scaffold and pure logic modules:

- Risk classifier for T1/T2/T3 tool calls
- Trust boundary checks for writable roots, protected paths, and allowed network hosts
- Loop detection for repetition, A/B alternation, step limits, and timeouts
- Judge prompt composition with source-aware remote-output stripping and fail-closed parsing
- Plugin adapter for `tool.execute.before`, `session.idle`, and compaction hooks
- Audit log and state persistence under `.opencode/`

Prompt Guard and conversational trust-boundary narrowing are intentionally deferred to Phase 2, matching the project plan.

## Install

Prerequisites:

- Bun 1.3 or newer
- OpenCode with plugin support

Install dependencies:

```sh
bun install
```

Run checks:

```sh
bun test
bun run typecheck
```

For local development in this repository, `opencode.json` already registers the plugin and `.opencode/modes/auto.md` registers the `auto` mode.

To install into another OpenCode project:

1. Add the agent to that project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "auto": {
      "mode": "primary",
      "prompt": "{file:.opencode/modes/auto.md}",
      "permission": "allow"
    }
  }
}
```

2. Install the plugin as a local OpenCode plugin file:

```sh
mkdir -p .opencode/plugins
cp /path/to/opencode-autopilot/.opencode/plugins/autopilot.ts .opencode/plugins/autopilot.ts
```

For this local plugin file to work, keep the `opencode-autopilot` repository checked out at the path referenced by its import, or adjust the import to point at your checkout's `src/index.ts`.

Do not run `opencode plugin opencode-autopilot`: that npm package name is already used by a different project.

3. Copy `modes/auto.md` to the target project:

```sh
mkdir -p .opencode/modes
cp modes/auto.md .opencode/modes/auto.md
```

4. Add Autopilot settings to `.opencode/autopilot.json`:

```json
{
  "maxSteps": 100,
  "timeoutMinutes": 30,
  "writableRoots": ["."],
  "allowedNetworkHosts": [],
  "bashFastScreen": false,
  "judgeIncludeRemoteOutputs": false,
  "judge": {
    "provider": null,
    "model": null
  }
}
```

5. Start OpenCode and press `Tab` until `auto` is selected.

## Configuration

OpenCode rejects unknown top-level config keys, so Autopilot settings live in `.opencode/autopilot.json`:

- `maxSteps`: maximum tool calls before autopilot stops
- `timeoutMinutes`: wall-clock timeout for a session
- `writableRoots`: paths where structured writes can be auto-approved
- `allowedNetworkHosts`: hostnames where read-only GET requests can be auto-approved
- `judge.provider` / `judge.model`: optional secondary judge model selection

Supported hosted judge providers are `anthropic`, `openai`, and `google`. Set the matching API key in the environment: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_API_KEY`. If no supported judge credentials are available, T3 actions fail closed with a denial.

Audit events are written to `.opencode/autopilot.log`; resumable state is written to `.opencode/autopilot-state.json`.
