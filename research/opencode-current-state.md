# OpenCode: Current State Research

> Research conducted: 2026-05-25

## Development Status

OpenCode is an active, open-source CLI coding agent (comparable to Claude Code) built by anomalyco. It runs as a TUI (terminal UI) and also supports server and web UI modes.

**Official repo:** https://github.com/anomalyco/opencode  
**Ecosystem list:** https://github.com/awesome-opencode/awesome-opencode  
**Config schema:** https://opencode.ai/config.json

### Key Features

- Full agentic coding: read, write, edit, bash execution, grep, glob, webfetch, todo management
- Multi-provider LLM support (Anthropic, OpenAI, Gemini, etc.) via unified provider config
- Session management with automatic context compaction
- Git worktree support and file watchers
- Plugin ecosystem with 50+ community plugins
- MCP (Model Context Protocol) server integration
- Prompt caching support
- Snapshot/undo/redo for file changes (`/undo`, `/redo`)
- Session sharing (`/share`)
- Background agent delegation

---

## Plugin System and Hooks

Plugins are JavaScript/TypeScript modules (run via Bun) placed in:
- `.opencode/plugins/` (project-level)
- `~/.config/opencode/plugins/` (global)
- Declared as npm packages in `opencode.json` under `"plugin": [...]`

### Plugin Structure

```typescript
export const MyPlugin = async ({ project, client, $, directory, worktree }) => {
  return {
    "tool.execute.before": async (input, output) => { /* intercept tools */ },
    "session.idle": async (event) => { /* on completion */ },
    "shell.env": async (input, output) => { output.env.MY_VAR = "value" },
    tool: { mytool: tool({ description, args, execute }) },
  }
}
```

### Available Hook Events

| Hook | Trigger |
|------|---------|
| `tool.execute.before` | Before any tool call executes |
| `tool.execute.after` | After any tool call completes |
| `session.created` | New session started |
| `session.idle` | Session completed / waiting |
| `session.compacted` | Context compaction happened |
| `session.updated` | Session state changed |
| `message.updated` | Message changed |
| `message.part.removed` | Message part removed |
| `file.edited` | File was edited by agent |
| `file.watcher.updated` | File changed on disk |
| `shell.env` | Inject env vars into shell execution |
| `tui.prompt.append` | Append to TUI prompt |
| `tui.command.execute` | Execute TUI command |
| `tui.toast.show` | Show toast notification in TUI |
| `experimental.session.compacting` | Inject context during compaction |

Plugins can also **define custom tools** that override built-in tools by name.

TypeScript type support: `import type { Plugin } from "@opencode-ai/plugin"`

---

## Modes

OpenCode has two built-in modes and supports unlimited custom modes:

| Mode | Behavior |
|------|----------|
| `build` | Default; all tools enabled |
| `plan` | Restricted; no file writes, edits, or bash (except `.opencode/plans/*.md`) |

Custom modes defined either in `opencode.json` under `"mode": {}` or as Markdown files in `.opencode/modes/` or `~/.config/opencode/modes/`.

Mode config controls: model, temperature, tool permissions (per-tool allow/deny), custom system prompt.

> Note: Modes are being migrated into the `agent` configuration system (`"mode"` key is deprecated but still supported).

---

## Architecture

### Config Layering (lower overrides higher)

1. Remote (`.well-known/opencode`) — organizational defaults
2. Global (`~/.config/opencode/opencode.json`)
3. Env var (`OPENCODE_CONFIG`)
4. Project (`opencode.json`)
5. Inline (`OPENCODE_CONFIG_CONTENT`)

All configs are merged, not replaced.

### Agents

Two agent types:
- `primary` — user-facing (build, plan)
- `subagent` — invoked by agents or `@mention` (general, explore, custom)

Each agent has independent: model, temperature, step limits, system prompt, per-tool permissions.

Task permissions control which subagents an agent can delegate to (**last-matching-rule-wins**).

### LLM Calls

Made via the `@opencode-ai/sdk` client (JS/TS SDK), with Go and Python SDKs also available. The server mode exposes an HTTP API consumed by TUI, web UI, and external tools.

### Sessions

Persistent, with automatic compaction when context fills. The `experimental.session.compacting` hook lets plugins inject summary context into compaction prompts. Sessions support snapshot/undo/redo.

### Built-in Tools

`bash`, `edit`, `write`, `read`, `grep`, `glob`, `list`, `patch`, `webfetch`, `todowrite`

---

## Extension Best Practices

1. **Single responsibility** — top plugins do one thing (notifications, env injection, guardrails)
2. **`tool.execute.before` for guardrails** — throw to block destructive ops before execution
3. **`shell.env` for environment injection** — cleaner than patching the agent prompt
4. **`session.idle` for async notifications** — fire after task completes
5. **`client.app.log()` not `console.log`** — structured logging with levels
6. **Support both local and npm distribution**
7. **`experimental.session.compacting`** for persistent state across context windows
8. **Study `oh-my-opencode`** for comprehensive orchestration patterns
9. **Skills (SKILL.md)** are compatible with Claude Code's skill format
10. **Permission rules use last-match-wins** — wildcards first, specific rules last

### Key Community Plugins

- `envsitter-guard` — guardrails via `tool.execute.before`
- `claude-code-safety-net` — safety net plugin
- `opencode-direnv` — env injection via `shell.env`
- `opencode-notify` — notifications via `session.idle`
- `oh-my-opencode` / `oh-my-opencode-slim` — comprehensive orchestration
