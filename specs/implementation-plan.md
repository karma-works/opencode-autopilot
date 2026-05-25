# OpenCode Autopilot: Implementation Plan

> Status: Draft  
> Date: 2026-05-25  
> Depends on: vision.md, ADR-001 through ADR-006

---

## Overview

Three phases. Phase 1 ships a working autopilot as a community plugin. Phase 2 proposes it to OpenCode core. Phase 3 handles hardening and ecosystem integration.

```
Phase 0: Pre-implementation verification  (days 1–2)  → resolve critical gaps
Phase 1: Plugin-Based Prototype           (weeks 1–4)  → working autopilot as plugin
Phase 2: Core Integration                 (weeks 5–10) → upstream PR to OpenCode
Phase 3: Hardening                        (weeks 11–14) → polish, security, ecosystem
```

---

## Phase 0: Pre-Implementation Verification (MUST complete before Phase 1)

Two questions must be answered by reading OpenCode's actual source code or running experiments. Without answers, Phase 1 cannot produce a working loop.

### 0.1 The Loop Driver ✅ RESOLVED

**`tui.prompt.append` cannot drive the loop.** It is a UI-only event that inserts text into the terminal input box via `input.insertText()` — the user still has to press Enter. Using it in an async loop is also dangerous: it targets the global active prompt and will dump text into the user's cursor position in any open session.

**The correct mechanism (verified from `packages/sdk/js/src/gen/sdk.gen.ts`):**

```javascript
await client.session.prompt({
  path: { id: sessionID },
  body: { parts: [{ type: "text", text: "Continue." }] }
});
```

This POSTs to `POST /session/{id}/message`, registers as a prompt submission, and kicks off a full agent execution cycle. It works identically in interactive TUI and headless/CI modes — there is no need for separate code paths. The session ID comes from `event.properties.sessionID` in the `session.idle` event. `client.executeCommand` does not exist.

**Task completion detection:** Agent is instructed via system prompt to emit a sentinel token `AUTOPILOT_DONE` as the last thing it writes when it considers the task complete. `session.idle` watches for this token (via `client.session.messages()`) and triggers clean shutdown. The sentinel is stripped from user-visible output. This is more reliable than trying to parse prose for completion signals.

### 0.2 Mode Selection UX ✅ RESOLVED

Verified from OpenCode source (`packages/opencode/src/cli/cmd/tui/context/local.tsx`, `keybind.ts`, `config/agent.ts`):

**Keyboard shortcuts (confirmed):**
- **Tab** → `agent_cycle` — cycles to next agent
- **Shift+Tab** → `agent_cycle_reverse` — cycles to previous agent
- **`<leader>a`** → `agent_list` — opens agent picker dialog

**Filter rule (confirmed):** Tab cycle shows all agents where `mode !== "subagent" && !hidden`. This includes both `mode: "primary"` and `mode: "all"` agents.

**Auto-registration (confirmed):** `loadMode()` in `config/agent.ts` scans `.opencode/modes/*.md` and assigns `mode: "primary"` automatically. Placing `auto.md` at `.opencode/modes/auto.md` registers it in the Tab cycle with no other configuration.

**Config key:** The current source uses `"agent"` (not `"mode"`) as the top-level key for agent definitions in `opencode.json`. `"mode"` is deprecated.

**Practical UX:** User places `auto.md` in `.opencode/modes/auto.md` and presses Tab to cycle to it. No CLI flag, no slash command needed. Switching is a live swap of the active agent — the conversation context remains.

### 0.3 Write the System Prompt (`modes/auto.md`) ✅ RESOLVED

Written at `modes/auto.md`. Key decisions:
- Agent works continuously without asking for permission mid-task
- `ToolBlockedError` → find alternative approach, never stop
- Completion signalled by sentinel token `AUTOPILOT_DONE` on its own line
- Escalation (stop, wait for user, do NOT emit `AUTOPILOT_DONE`) only after 3+ failed attempts or genuinely missing information

### 0.4 Write the Judge Prompts ✅ RESOLVED

Written at `src/judge/policy-template.md` and `src/judge/policy.md`.

Both adapted from openai/codex (Apache 2.0) with attribution. Key adaptations:
- Replaced org/tenant language with workspace/session language
- Removed Codex's interactive tool-call investigation guidelines (our judge is single-shot, not an interactive agent)
- Added OpenCode-specific policy categories: filesystem trust boundary violation, external network state mutation, irreversible remote action
- Kept universally applicable sections: data exfiltration, credential probing, persistent security weakening, destructive local actions
- Added `suggested_alternative` field to output schema
- Template variable renamed from `{tenant_policy_config}` to `{workspace_policy}`

### 0.5 Decide: Llama Prompt Guard in Phase 1 or Defer?

Llama Prompt Guard 2-86M is a BERT-style encoder — it cannot run through OpenCode's provider system or Ollama. Running it requires either:
- **Option A:** Transformers.js in Bun — feasible, adds a significant dependency (~200MB model download on first run)
- **Option B:** HuggingFace Inference API — adds a second API key requirement, defeats zero-setup goal
- **Option C:** Defer to Phase 2 — Phase 1 ships without injection scanning on tool outputs; warning is added to README

**Recommendation: Option C for Phase 1.** The primary injection defense is the judge never seeing remote tool outputs (ADR-002 source-aware stripping). The Prompt Guard layer adds defense-in-depth but is not required for basic functionality. Defer to Phase 2 when it can be implemented properly.

### 0.6 Scope Out Conversational Trust Narrowing for Phase 1

ADR-005 promises mid-session narrowing ("don't push"). Implementing this correctly requires either keyword matching (fragile) or an LLM classification call on every user message (expensive). **Scope this out of Phase 1 explicitly.** Phase 1 ships with config-file-only trust boundary definition. Add to Phase 2 backlog.

### 0.7 Scope Out Scope-Pinning Startup Hint for Phase 1

ADR-005 describes an LLM call at autopilot activation that suggests a minimum trust boundary. This is a significant extra feature. **Scope out of Phase 1.** Deferred to Phase 2.

---

## Phase 1: Plugin-Based Prototype

### Goal

Ship a complete, production-usable autopilot as an OpenCode plugin. All core logic (risk classification, judge integration, loop detection) lands here and is tested independently of core.

### Core-Readiness Design Principles

Phase 1 is explicitly designed so that migrating to OpenCode core (Phase 2) requires rewriting only the plugin adapter layer, not the business logic. Every architectural decision below follows from this goal.

**1. Strict module boundary: adapter vs. logic**

`src/index.ts` is the only file that imports `@opencode-ai/plugin`. It is a thin adapter — its only job is translating hook inputs into calls to the pure logic modules and back. All logic in `src/classifier/`, `src/judge/`, `src/loop/`, `src/trust/`, and `src/audit/` has zero dependency on the plugin SDK.

When contributing to core, `src/index.ts` is discarded and replaced with a new adapter against OpenCode's internal APIs. Nothing else changes.

```
src/index.ts            ← ADAPTER: imports @opencode-ai/plugin, wires hooks to logic
src/classifier/         ← LOGIC: pure TypeScript, no plugin SDK imports
src/judge/              ← LOGIC: pure TypeScript, no plugin SDK imports
src/loop/               ← LOGIC: pure TypeScript, no plugin SDK imports
src/trust/              ← LOGIC: pure TypeScript, no plugin SDK imports
src/audit/              ← LOGIC: pure TypeScript, no plugin SDK imports
```

**2. No `any` types. Strict TypeScript throughout.**

`tsconfig.json` sets `"strict": true` and `"noUncheckedIndexedAccess": true`. All function signatures, return types, and interface fields are explicitly typed. This is required by OpenCode core and catches integration errors before they reach runtime.

**3. No external runtime dependencies beyond `@opencode-ai/plugin`.**

Every runtime dependency adds friction to core integration. Use:
- `Bun.file` / `Bun.write` for file I/O (available in the OpenCode runtime)
- `fetch` (native, used by OpenCode's own SDK)
- No lodash, axios, or other utility libraries

`@opencode-ai/sdk` is a `devDependency` only — the client is passed in via `PluginInput.client`.

**4. Use structured logging, not `console.log`.**

In the plugin adapter: `client.app.log({ level: "info", message: "..." })`. In pure logic modules: accept a logger interface as a parameter so the same code works with OpenCode's internal logger in Phase 2.

**5. Tests run against pure logic modules with no plugin SDK mocking.**

Because the logic modules have no plugin SDK imports, `classifier.test.ts`, `loop.test.ts`, etc. run as plain Bun tests with zero mocking of OpenCode internals. This is the main practical benefit of the boundary discipline.

**6. Phase 1-specific workarounds are isolated and labelled.**

Two patterns in the adapter will change in Phase 2:
- `fetch(new URL("/tui/publish", serverUrl), ...)` → replaced with a proper TUI API call
- `client.session.messages()` polling to detect `AUTOPILOT_DONE` → replaced with a stream listener or dedicated event

These are confined to `src/index.ts` and marked with `// PHASE1-WORKAROUND:` comments so they are easy to find and replace.

---

### File Structure

```
opencode-autopilot/
  src/
    index.ts                    # ADAPTER ONLY — plugin entry point, wires hooks to logic
    classifier/
      tier.ts                   # Risk tier types (T1/T2/T3)
      classify.ts               # classifyToolCall() — pure function, no SDK imports
    judge/
      client.ts                 # judge() — pure function, accepts OpencodeClient interface
      policy-template.md        # Fixed judge rules framework
      policy.md                 # Pluggable outcome risk taxonomy
      types.ts                  # JudgeDecision, JudgeConfig types
    loop/
      detector.ts               # detectLoop() — pure function of call history
      state.ts                  # AutopilotState type and Bun-backed persistence
    trust/
      boundary.ts               # isWithinBoundary() — pure function
      protected-paths.ts        # Protected path list
    audit/
      logger.ts                 # AuditLogger — accepts a write function, no Bun direct calls
  modes/
    auto.md                     # Agent system prompt for auto mode
  test/
    classifier.test.ts          # No mocking needed — pure function tests
    loop.test.ts                # No mocking needed — pure function tests
    judge.test.ts               # Mocks the LLM call only, not plugin SDK
    trust.test.ts               # No mocking needed — pure function tests
    index.test.ts               # Integration test: full hook wiring with mock PluginInput
  opencode.json                 # Mode definition + autoMode config defaults
  package.json
  tsconfig.json                 # strict: true, noUncheckedIndexedAccess: true
  tsconfig.build.json           # emitDeclarationOnly: true for publishing
  README.md
```

### 1.1 Risk Classifier (`src/classifier/`)

Pure function: `classifyToolCall(tool: string, args: Record<string, unknown>, boundary: TrustBoundary): Tier`

Tier assignments per ADR-004:
- **T1:** `read`, `grep`, `glob`, `list` within trust boundary; `webfetch` GET to allowedNetworkHosts
- **T2:** `write`, `edit`, `patch` within writableRoots and not protected path; `todowrite`; `webfetch` GET to localhost
- **T3:** All `bash` calls (unconditionally); structured tool writes outside writableRoots or to protected paths; `webfetch` POST/PUT/DELETE; `webfetch` GET to non-allowed hosts

Test coverage:
- All built-in OpenCode tools classified correctly
- All border cases from ADR-004 table covered
- Protected path list: every entry has a test
- Edge cases: symlinks, relative paths that escape CWD (`../`), absolute paths

### 1.2 Judge Client (`src/judge/`)

```typescript
interface JudgeDecision {
  decision: "ALLOW" | "DENY";
  rationale: string;
  suggestedAlternative?: string;
}

async function judge(
  userMessages: Message[],
  toolCallHistory: ToolCallSummary[],  // source-aware: remote outputs stripped
  proposedCall: ProposedToolCall,
  trustBoundary: TrustBoundary,
  config: JudgeConfig,
): Promise<JudgeDecision>
```

Uses OpenCode's existing provider client (`@opencode-ai/sdk`) — same auth, same model selection as primary agent.

Default model: cheapest model from user's configured primary provider:
- Anthropic → `claude-haiku-4-5`
- OpenAI → `gpt-4o-mini`
- Google → `gemini-2.0-flash-lite`
- Other → same model as primary agent

Source-aware output stripping (ADR-002):
- Local tool outputs (bash stdout from local commands, file reads, grep results): included
- Remote outputs (webfetch responses, bash stdout from curl/wget/ssh): stripped

Failure modes: fail-closed on timeout (> 5s), network error, or unparseable response.

### 1.3 Loop Detector (`src/loop/`)

```typescript
interface LoopDetectionResult {
  detected: boolean;
  type?: "repetition" | "alternation" | "step-limit" | "timeout";
  message?: string;
}

function detectLoop(state: AutopilotState, newCall: ToolCallSummary): LoopDetectionResult
```

Four mechanisms (ADR-003):
1. Step limit (default 100, configurable)
2. Identical-call repetition (3 consecutive identical tool+args)
3. A-B alternation (2 complete A→B→A→B cycles)
4. Wall-clock timeout (default 30 min, configurable)

Plus circuit breaker: 3 consecutive judge denials or 10 total denials → pause + escalate.

### 1.4 Plugin Entry Point (`src/index.ts`)

```typescript
import type { Plugin } from "@opencode-ai/plugin";

export const AutopilotPlugin: Plugin = async ({ project, client, directory, serverUrl }) => {
  const config = loadAutoModeConfig(project);
  // Map<sessionID, AutopilotState> — community pattern for multi-session safety
  const sessions = new Map<string, AutopilotState>();

  return {
    // Named hook: fires before every tool call, can throw to cancel
    "tool.execute.before": async (input, output) => {
      // input: { tool, sessionID, callID }  output: { args }
      const state = sessions.get(input.sessionID);
      if (!state) return; // not an autopilot session
      const tier = classifyToolCall(input.tool, output.args, config.trustBoundary);

      if (tier === Tier.T3) {
        const decision = await judge(/* ... source-aware history ... */);
        if (decision.decision === "DENY") {
          state.recordDenial(decision);
          checkCircuitBreaker(state);
          throw new ToolBlockedError(decision.rationale, decision.suggestedAlternative);
        }
      }

      const loopResult = detectLoop(state, { tool: input.tool, args: output.args });
      if (loopResult.detected) throw new LoopDetectedError(loopResult.message);

      state.recordCall({ tool: input.tool, args: output.args, tier });
      auditLog.write({ tool: input.tool, tier, decision: "ALLOW" });
    },

    // Named hook: inject denial/loop history into compaction context
    "experimental.session.compacting": async (input, output) => {
      const state = sessions.get(input.sessionID);
      if (!state) return;
      // inject state summary into output.context[] so it survives compaction
    },

    // Unified event hook: handles all session lifecycle events
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const sessionID = event.properties.info.id;
        sessions.set(sessionID, await loadOrInitState(directory, sessionID));
        return;
      }

      if (event.type === "session.compacted") {
        await sessions.get(event.properties.sessionID)?.persist();
        return;
      }

      if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID;
        const state = sessions.get(sessionID);
        if (!state) return; // not an autopilot session

        // Check for AUTOPILOT_DONE sentinel via SDK — no direct access to output buffer
        const messages = await client.session.messages({ path: { id: sessionID } });
        const lastAssistant = messages.data?.findLast((m) => m.info.role === "assistant");
        const lastText = lastAssistant?.parts?.findLast((p) => p.type === "text")?.text ?? "";
        if (lastText.trimEnd().endsWith("AUTOPILOT_DONE")) {
          await auditLog.writeCompletion(state);
          sessions.delete(sessionID);
          return; // task complete — do not inject continuation
        }

        if (state.circuitBreakerTripped) {
          // POST /tui/publish — HTTP endpoint confirmed; SDK wrapper method not yet verified
          await fetch(new URL("/tui/publish", serverUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "tui.toast.show", properties: { message: "[AUTO PAUSED] Too many denials. Review autopilot.log.", variant: "error" } }),
          });
          return; // paused — wait for user intervention
        }
        if (Date.now() - state.startedAt > config.timeoutMs) {
          await client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text: "AUTOPILOT_TIMEOUT: summarise what you completed and what remains." }] } });
          return;
        }
        await client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text: "Continue." }] } });
      }
    },
  };
};
```

### 1.5 Auto Mode System Prompt (`modes/auto.md`)

Written at `modes/auto.md` (Phase 0.3 ✅). Key behaviours encoded: work continuously without asking permission, treat `ToolBlockedError` as a signal to find an alternative approach, emit `AUTOPILOT_DONE` on its own line only when the task is genuinely complete, escalate (without emitting the sentinel) only after 3+ failed attempts or genuinely missing information.

### 1.6 Mode Definition (`opencode.json`)

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
    "bashFastScreen": false,
    "judgeIncludeRemoteOutputs": false,
    "judge": {
      "provider": null,
      "model": null
    }
  }
}
```

`judge.provider` and `judge.model` default to null — the plugin auto-selects the cheapest model from the user's configured primary provider.

### Phase 1 Success Criteria

- [ ] Plugin installs via `opencode.json` `plugin` list with zero additional setup
- [ ] User can activate `auto` mode by pressing Tab to cycle to it (auto-registered via `.opencode/modes/auto.md`)
- [ ] Agent runs multiple turns autonomously without user input
- [ ] T1/T2 tool calls execute without judge invocation
- [ ] All `bash` calls invoke the LLM judge
- [ ] Judge DENY injects `ToolBlockedError` with rationale; agent attempts alternative approach
- [ ] Loop detection fires within 3 identical consecutive calls
- [ ] Circuit breaker pauses autopilot after 3 consecutive denials
- [ ] State survives session compaction
- [ ] Audit log written to `.opencode/autopilot.log`
- [ ] Headless mode exits with correct exit codes: 0 (complete), 1 (circuit breaker), 2 (loop), 3 (timeout), 4 (step limit)
- [ ] No `@opencode-ai/plugin` imports outside `src/index.ts` (boundary discipline — verify with `grep -r "@opencode-ai/plugin" src/ --include="*.ts" | grep -v "src/index.ts"` returning empty)
- [ ] All pure logic tests pass with zero plugin SDK mocking

---

## Phase 2: Core Integration

### Goal

Contribute `auto` mode as a first-class mode to OpenCode core, with proper TUI integration and lifecycle hooks.

### Migration from Phase 1

Because Phase 1 enforces strict adapter/logic separation, the migration is surgical:

1. **Copy `src/classifier/`, `src/judge/`, `src/loop/`, `src/trust/`, `src/audit/` verbatim** into the OpenCode monorepo (likely `packages/opencode/src/auto/`). No changes required — these modules have no plugin SDK dependencies.
2. **Discard `src/index.ts`** (the plugin adapter).
3. **Write a new core adapter** that calls the same logic functions from OpenCode's internal agent loop, replacing the two Phase 1 workarounds:
   - `fetch(/tui/publish)` → internal TUI event emission
   - `client.session.messages()` polling → stream listener or dedicated `session.idle` event payload
4. **Replace `PHASE1-WORKAROUND:` comments** — grep for these in the codebase to find everything that needs changing.
5. **Verify tests still pass unchanged** — pure logic tests require no modification.

### Prerequisites

- Phase 1 plugin shipped and used in practice (min 4 weeks)
- OpenCode maintainers engaged via GitHub issue before PR
- Phase 1 loop driver mechanism validated in production

### Deliverables

**2.1 New lifecycle hooks** — proposed to OpenCode core:
```
automode.action.classifying
automode.action.evaluating
automode.action.allowed
automode.action.denied
automode.loop.detected
automode.circuitbreaker.trip
automode.session.complete
```

**2.2 TUI status bar:**
- `[AUTO 42/100]` — mode + step counter
- `T2 ✓` / `T3 ✓` / `T3 ✗` — tier of last action
- `[AUTO PAUSED — 3 denials] [c]ontinue [q]uit [b]uild-mode` — circuit breaker state
- `/trust` command — show active trust boundary and constraints

**2.3 First-class mode registration** — `auto` appears in TUI mode selector alongside `build` and `plan`, with keybinding

**2.4 Async judge in agent loop** — proper async integration without event-loop blocking workarounds

**2.5 Llama Prompt Guard integration** — injection scan on tool outputs via Transformers.js in Bun

**2.6 Conversational trust narrowing** — detect explicit constraint phrases in user messages

### Phase 2 Success Criteria

- [ ] `auto` mode in TUI mode selector without plugin
- [ ] Status bar shows step count and last action tier
- [ ] Circuit breaker UI is interactive
- [ ] `automode.*` lifecycle hooks documented and tested
- [ ] Phase 1 plugin continues working as a compatibility shim

---

## Phase 3: Hardening and Ecosystem

**3.1** Adversarial test suite (prompt injection corpus, known evasion patterns)  
**3.2** CI/CD integration (GitHub Actions workflow, `--json` event stream, Docker config)  
**3.3** Observability (OpenTelemetry traces, Grafana dashboard template)  
**3.4** Trust boundary profiles (`strict`, `standard`, `open`)  
**3.5** Scope-pinning startup hint (LLM-inferred minimum trust boundary suggestion)

---

## Key Technical Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `session.idle` + `tui.prompt.append` cannot drive the loop autonomously | **High** | Phase 0.1 resolves this before any other work |
| OpenCode plugin API changes break Phase 1 | Medium | Pin to tested OpenCode version; integration tests |
| Judge latency degrades UX on CPU-only machines | Medium | `bashFastScreen` opt-in; document GPU recommendation |
| `experimental.session.compacting` hook removed | Low | Graceful fallback: inject constraints into next user prompt |
| Judge prompt jailbroken via crafted tool argument | Low | Adversarial test suite in Phase 3 |
| Loop detection false positives on legitimate repeated calls | Medium | Tunable thresholds; window size configurable |
| OpenCode core PR rejected | Low | Pre-PR discussion; Phase 1 plugin remains viable long-term |

---

## Open Questions Resolved

1. **Judge model auto-selection:** Cheapest model from user's configured primary provider. No explicit config required. ✅
2. **T3 → T2 elevation:** Users add hosts to `allowedNetworkHosts` (webfetch) or expand `writableRoots` (writes). No arbitrary pattern elevation. ✅
3. **Conversational trust narrowing:** Deferred to Phase 2. ✅
4. **Multi-agent:** Subagent tool calls — behavior depends on whether `tool.execute.before` fires for subagent calls. Verify in Phase 0.1. Proposed behavior: yes, same judge, subagent's delegated task as stated intent.
5. **Llama Prompt Guard:** Deferred to Phase 2. ✅
6. **Cost accounting:** Judge calls logged with model/provider. Aggregated cost display deferred to Phase 2. ✅
