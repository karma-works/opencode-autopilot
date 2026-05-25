# OpenCode Plugin Patterns and Scaffolding

> Source: https://github.com/awesome-opencode/awesome-opencode  
> Research date: 2026-05-25  
> Purpose: Establish best practices for implementing opencode-autopilot as a community plugin

---

## Repository Structure

`awesome-opencode` is a **curated list**, not a monorepo. It contains YAML metadata files pointing to 67+ separately hosted plugin repositories. Structure:

```
awesome-opencode/
├── data/
│   ├── plugins/           # 67+ YAML metadata entries
│   ├── agents/
│   ├── themes/
│   └── resources/
├── scripts/               # README generator, validator
└── templates/
```

Plugins researched in detail: `opencode-agent-memory`, `opencode-agent-identity`, `opencode-plugin-otel`, `opencode-dynamic-context-pruning`, `opencode-plugin-template`.

---

## Plugin Export Convention

Every plugin exports a **named async function** typed as `Plugin` from `@opencode-ai/plugin`:

```typescript
import type { Plugin } from '@opencode-ai/plugin';

export const AutopilotPlugin: Plugin = async ({ directory, client, project }) => {
  // one-time initialization here

  return {
    // hook handlers
  };
};
```

Key points:
- Named export (not default export) — the export name becomes the plugin identifier
- The function receives `PluginInput` and returns a `PluginHooks` object
- OpenCode discovers the plugin by package name via `opencode.json` `"plugin"` array

`PluginInput` shape (verified from `packages/plugin/src/index.ts`):
```typescript
{
  directory: string;            // plugin directory path
  client: OpencodeClient;       // SDK client (session.prompt, session.messages, etc.)
  project: ProjectInfo;         // current project metadata
  worktree?: string;            // git worktree path if applicable
  serverUrl: URL;               // OpenCode HTTP server URL
  $: BunShell;                  // Bun shell for subprocess execution
  experimental_workspace: {
    register(type: string, adapter: WorkspaceAdapter): void;
  };
}
```

---

## Hook Architecture (Confirmed from Community Plugins)

Two distinct hook mechanisms coexist:

### Named Hooks (structured input/output pairs)

These have typed `input` and `output` parameters. Plugins can mutate `output` to inject content.

| Hook | Input | Output | Use case |
|------|-------|--------|----------|
| `tool.execute.before` | `{ tool, sessionID, callID }` | `{ args }` | Block/inspect tool calls |
| `tool.execute.after` | `{ tool, sessionID, callID, args }` | `{ title, output, metadata }` | Post-process results |
| `experimental.session.compacting` | `{ sessionID }` | `{ context: string[], prompt? }` | Inject into compaction |
| `experimental.chat.system.transform` | `{ sessionID }` | `{ system: string[] }` | Inject into system prompt |
| `experimental.chat.messages.transform` | — | `{ messages }` | Transform message history |
| `chat.message` | `{ sessionID, agent, messageID, ... }` | `{ message, parts }` | Intercept user messages |
| `config` | `opencodeConfig` | mutate in-place | Modify OpenCode config at startup |

### Unified `event` Hook (all session/TUI events)

A single `event` handler receives all events. Discriminate by `event.type`:

```typescript
event: async ({ event }) => {
  switch (event.type) {
    case "session.created":   // event.properties.info: Session
    case "session.idle":      // event.properties.sessionID: string
    case "session.compacted": // event.properties.sessionID: string
    case "session.error":
    case "session.status":
    case "session.diff":
    case "message.updated":
    case "message.part.updated":
    case "command.executed":
    case "permission.updated":
    case "permission.replied":
    // tui.toast.show, tui.prompt.append, file.edited, and 20+ others
  }
}
```

From the OTEL plugin (`opencode-plugin-otel/src/index.ts`):
```typescript
event: async ({ event }) => {
  switch (event.type) {
    case "session.created":
      await handleSessionCreated(event, ctx); break;
    case "session.idle":
      handleSessionIdle(event, ctx); break;
    case "session.error":
      handleSessionError(event, ctx); break;
    // ...
  }
}
```

### Tool Registration

Plugins can register custom LLM-callable tools:

```typescript
import { tool } from '@opencode-ai/plugin';

return {
  tool: {
    my_tool: tool({
      description: "What this tool does",
      args: {
        param: tool.schema.string().describe("param description"),
      },
      async execute(args, context) {
        // context.sessionID available
        const messages = await client.session.messages({ path: { id: context.sessionID } });
        return "result string";
      },
    }),
  },
};
```

---

## Loop Driver API (Verified)

To trigger a new agent turn programmatically from the `session.idle` event:

```typescript
await client.session.prompt({
  path: { id: event.properties.sessionID },
  body: {
    parts: [{ type: "text", text: "Continue." }]
  }
});
```

This is confirmed by the SDK type (`SessionPromptData` in `packages/sdk/js/src/gen/types.gen.ts`), which maps to `POST /session/{id}/message`. There is no `client.executeCommand()` method — use `client.session.command()` for slash commands, `client.session.prompt()` for message injection.

---

## Dependency Handling (Most Important Section)

### Loading Model

OpenCode loads plugins at runtime by **importing the compiled JS entry point**. Plugins are **not bundled** by OpenCode. `node_modules` must be present in the plugin's own directory.

Two loading modes:
1. **npm package** (production): OpenCode fetches by package name from npm, caches locally
2. **local file symlink** (development): `ln -sf /path/to/plugin/src/index.ts ~/.config/opencode/plugin/myplugin.ts`

### Dependency Declarations

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.0.115"
  },
  "devDependencies": {
    "@opencode-ai/sdk": "^1.14.18",
    "@types/bun": "^1.3.3",
    "typescript": "^5.9.3"
  }
}
```

Rules:
- `@opencode-ai/plugin` → **`dependencies`** (runtime, always required)
- `@opencode-ai/sdk` → **`devDependencies`** (used for types only; the actual client is passed in via `PluginInput.client`)
- Third-party packages used at runtime → **`dependencies`**
- Bun-native APIs (`Bun.file`, `Bun.Glob`, `$`) need no dependency — available in Bun runtime

Example with heavy third-party deps (agent-memory):
```json
{
  "dependencies": {
    "@huggingface/transformers": "^3.8.1",
    "@opencode-ai/plugin": "^1.0.115",
    "js-yaml": "^4.1.0",
    "zod": "^4.1.13"
  }
}
```

### Bun-Native API Usage

Community plugins use Bun APIs extensively and without import:

```typescript
// File I/O
const content = await Bun.file(filePath).text();
await Bun.write(filePath, JSON.stringify(state));

// Glob
const glob = new Bun.Glob('**/*.md');
for await (const file of glob.scan({ cwd: dir, absolute: true })) { ... }

// Shell (from PluginInput.$)
const result = await $`git log --oneline -10`.text();
```

No package install needed — these are Bun builtins available at runtime.

### Lock File

Every plugin commits `bun.lock` to git. Some plugins use `overrides` to pin transitive dependencies (e.g., pinning `onnxruntime-node` for HuggingFace):

```json
{
  "overrides": {
    "onnxruntime-node": "1.20.1"
  }
}
```

---

## Build Setup

### package.json

```json
{
  "name": "opencode-autopilot",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist", "src/version.ts"],
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target node --format esm && bun run build:types",
    "build:types": "tsc --project tsconfig.build.json --noEmitOnError false",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@opencode-ai/plugin": "^1.0.115"
  },
  "devDependencies": {
    "@opencode-ai/sdk": "^1.14.18",
    "@types/bun": "^1.3.3",
    "typescript": "^5.9.3"
  },
  "engines": { "bun": ">=1.0.0" }
}
```

### tsconfig.json (development — type checking only)

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "types": ["bun-types"]
  },
  "include": ["src", "test"],
  "exclude": ["node_modules", "dist"]
}
```

### tsconfig.build.json (emit declarations for publish)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "emitDeclarationOnly": true,
    "noEmit": false,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "node_modules"]
}
```

### Build Pipeline

1. `bun build src/index.ts --outdir dist --target node --format esm` — transpile TS → ESM JS
2. `tsc --project tsconfig.build.json` — emit `.d.ts` files
3. Published `dist/` contains both `index.js` and `index.d.ts`
4. Source TypeScript is NOT shipped (only `src/version.ts` as an exception)

Alternatively, some plugins use `tsup` for more complex bundling scenarios.

---

## System Prompt Injection Pattern

The `experimental.chat.system.transform` hook lets plugins insert into the system prompt array. From agent-memory:

```typescript
"experimental.chat.system.transform": async (_input, output) => {
  const content = await generateSystemAddition();

  // Insert early (after provider header) for prompt cache efficiency
  const insertAt = output.system.length > 0 ? 1 : 0;
  output.system.splice(insertAt, 0, content);

  // Append instructions at the end (tail doesn't affect cache prefix)
  output.system.push(appendedInstructions);
},
```

Key insight: `output.system` is an array of chunks. OpenCode joins them. Inserting at position 1 (not 0) preserves the provider header chunk as a stable cache prefix.

---

## Session State Sharing Pattern

From agent-identity: share state across hooks using a closure:

```typescript
export const AutopilotPlugin: Plugin = async () => {
  // Shared state initialized once per plugin load
  const stateBySession = new Map<string, AutopilotState>();

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        stateBySession.set(event.properties.info.id, initState());
      }
      if (event.type === "session.idle") {
        const state = stateBySession.get(event.properties.sessionID);
        if (!state) return;
        // use state
      }
    },

    "tool.execute.before": async (input, output) => {
      // input.sessionID connects back to the map
      const state = stateBySession.get(input.sessionID);
    },
  };
};
```

---

## opencode.json Registration

```json
{
  "plugin": ["opencode-autopilot"],
  "agent": {
    "auto": {
      "model": "claude-sonnet-4-6",
      "systemPrompt": ".opencode/modes/auto.md",
      "tools": { "allow": ["*"], "deny": [] }
    }
  },
  "autoMode": {
    "maxSteps": 100,
    "timeoutMinutes": 30,
    "writableRoots": ["."],
    "allowedNetworkHosts": [],
    "judge": { "provider": null, "model": null }
  }
}
```

Note: `"agent"` is the current config key (not `"mode"` which is deprecated).

---

## Implications for opencode-autopilot

1. **No `client.executeCommand()`** — use `client.session.prompt({ path: { id: sessionID }, body: { parts: [...] } })`
2. **Session events via unified `event` hook** — `session.idle`, `session.created`, `session.compacted` are not named hooks
3. **`tool.execute.before` args** are on `output.args`, not `input.args`
4. **State across hooks** — use a `Map<sessionID, AutopilotState>` closure, not module-level globals
5. **`@opencode-ai/sdk` in devDependencies** — the SDK client is already passed in; no production dep needed
6. **Bun APIs free** — use `Bun.file()`, `Bun.write()`, `Bun.Glob` without extra dependencies
7. **No bundling by OpenCode** — `node_modules` must exist in plugin directory; ship compiled `dist/`
8. **ESM only** — `"type": "module"` in package.json, all imports use ESM syntax
