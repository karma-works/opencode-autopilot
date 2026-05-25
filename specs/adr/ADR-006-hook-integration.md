# ADR-006: Hook Integration Strategy

- **Status:** Accepted
- **Date:** 2026-05-25
- **Deciders:** Christian Haegele

---

## Context

The Phase 1 plugin implementation must integrate with OpenCode's existing hook system. This ADR decides which hooks to use, how to handle async operations within synchronous hook contexts, and what state management approach to take.

---

## Primary Hook: `tool.execute.before`

This is the core integration point. It fires before every tool call and can throw to cancel execution.

**Verified signature** (from `packages/plugin/src/index.ts`):
```typescript
"tool.execute.before"?: (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any }  // args are on output, not input
) => Promise<void>
```

**What the hook does:**
1. Receive proposed tool call: `input.tool` (name), `output.args` (arguments), `input.sessionID`
2. Run risk classification (`classifyToolCall`) → T1/T2/T3
3. For T1/T2: log to audit trail, allow execution (return without throwing)
4. For T3: invoke secondary LLM judge (async), await decision
   - ALLOW: log, allow execution
   - DENY: log denial, update circuit breaker counter, throw `ToolBlockedError` with rationale
5. Update loop detection state (step counter, call history)
6. Check loop detection conditions — if triggered, throw appropriate error

**Async in `tool.execute.before`:** OpenCode's plugin system runs Bun (which supports top-level async). The hook can `await` the judge LLM call. This is the correct approach — blocking is acceptable here because the alternative (allowing execution before the judge responds) defeats the purpose.

---

## Secondary Hooks

**Plugin hook architecture (verified from source):**

OpenCode plugins expose two hook mechanisms:
1. **Named hooks** for specific lifecycle points with structured input/output: `tool.execute.before`, `tool.execute.after`, `experimental.session.compacting`, `chat.message`
2. **Unified `event` hook** for all other events: receives `{ event: Event }` where `event.type` discriminates the event

Session lifecycle events (`session.created`, `session.idle`, `session.compacted`, `session.updated`) come through the unified `event` hook, not as named hooks.

### `session.created` (via `event` hook)

```typescript
event: async ({ event }) => {
  if (event.type !== "session.created") return;
  // event.properties.info: Session
  // Initialize autopilot state on session start
}
```

Initialize autopilot state on session start:
- Load persisted state from `.opencode/autopilot-state.json` (for resumed sessions)
- Initialize step counter, call history ring buffer, start time
- Validate trust boundary configuration
- Log session start with configured parameters

### `session.idle` (via `event` hook)

Fires when the agent completes a turn and is waiting for input. This is the loop driver hook.

**`tui.prompt.append` cannot drive the loop.** It inserts text into the TUI's visible input box (`input.insertText(text)`) — a UI-only mutation. The user still has to press Enter. Using it in an async loop is also dangerous: it targets the global active prompt, so if a background loop fires while the user has a different session open, it dumps text into their current cursor position.

**One reliable option to trigger a new agent turn (verified from source):**

**`client.session.prompt()` — the correct SDK method:**
```javascript
await client.session.prompt({
  path: { id: sessionID },
  body: {
    parts: [{ type: "text", text: "continue with the task" }]
  }
});
```
This is the actual OpenCode SDK method (from `@opencode-ai/sdk`, `packages/sdk/js/src/gen/sdk.gen.ts`). It POSTs to `POST /session/{id}/message`, registers as a prompt submission, and kicks off a full agent execution cycle. The session ID comes from `event.properties.sessionID` in the `session.idle` event.

**Note on `client.executeCommand`:** This method does not exist. The nearest analogue is `client.session.command()` which executes a slash command (not a message/prompt). The correct method for injecting a continuation message is `client.session.prompt()`.

**HTTP API directly (for headless/CI where no plugin client is available):**
`POST /session/{id}/message` with JSON body `{ "parts": [{ "type": "text", "text": "continue" }] }`. Identical semantics to `client.session.prompt()` — it is the underlying HTTP endpoint that the SDK method calls.

**Loop driver logic in the `event` hook (session lifecycle events come via unified `event` hook):**

```typescript
// sessions: Map<sessionID, AutopilotState> — initialised in session.created
event: async ({ event }) => {
  if (event.type !== "session.idle") return;
  const sessionID = event.properties.sessionID;
  const state = sessions.get(sessionID);
  if (!state) return; // not an autopilot session

  // Check for AUTOPILOT_DONE sentinel in the last assistant message
  const messages = await client.session.messages({ path: { id: sessionID } });
  const lastAssistant = messages.data?.findLast((m) => m.info.role === "assistant");
  const lastText = lastAssistant?.parts?.findLast((p) => p.type === "text")?.text ?? "";
  if (lastText.trimEnd().endsWith("AUTOPILOT_DONE")) {
    await auditLog.writeCompletion(state);
    sessions.delete(sessionID);
    return; // task complete — do not inject continuation
  }

  if (state.isCircuitBreakerTripped()) {
    // Too many denials — pause, alert user, wait for intervention
    // Publishes via POST /tui/publish (HTTP endpoint confirmed; SDK wrapper method TBD)
    await fetch(new URL("/tui/publish", serverUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "tui.toast.show", properties: { message: "[AUTO PAUSED] Circuit breaker tripped. Review autopilot.log.", variant: "error" } }),
    });
    return; // do not inject continuation — wait for user
  }

  const loopResult = detectTimeout(state); // wall-clock check
  if (loopResult.detected) {
    await handleTermination(loopResult, state, client, sessionID);
    return;
  }

  // Inject continuation to keep the loop running
  await client.session.prompt({
    path: { id: sessionID },
    body: { parts: [{ type: "text", text: "Continue." }] }
  });
}
```

**Detecting task completion:** The plugin fetches recent messages via `client.session.messages()` and checks whether the last assistant text part ends with `AUTOPILOT_DONE`. This is the only reliable approach — the plugin has no direct access to the streaming output buffer.

Phase 1 uses the **sentinel phrase** approach. The sentinel is stripped from user-visible output before display (handled by the agent system prompt instructing it to emit the token as the very last thing).

### `session.compacted` (via `event` hook)

```typescript
event: async ({ event }) => {
  if (event.type !== "session.compacted") return;
  // event.properties.sessionID
}
```

Fires after context compaction. The plugin must:
- Persist current loop detection state to `.opencode/autopilot-state.json`
- Verify state was saved correctly before allowing session to continue

### `experimental.session.compacting` (named hook)

Fires before compaction starts, allowing injection of context into the compaction prompt. The plugin injects:
- Count of steps taken so far
- List of denied actions with rationales (so the new context window remembers what failed)
- Active conversational trust constraints
- Current loop detection status

This ensures the agent's next context window is aware of past failures and constraints without relying on the call history (which was compacted away).

---

## Mode Definition

The `auto` mode is defined in `opencode.json` (project-level) or `~/.config/opencode/opencode.json` (global):

```json
{
  "agent": {
    "auto": {
      "model": "claude-sonnet-4-6",
      "systemPrompt": ".opencode/modes/auto.md",
      "tools": {
        "allow": ["*"],
        "deny": []
      }
    }
  },
  "autoMode": {
    "maxSteps": 100,
    "timeoutMinutes": 30,
    "writableRoots": ["."],
    "allowedNetworkHosts": [],
    "judge": {
      "model": "claude-haiku-4-5",
      "provider": "anthropic"
    }
  }
}
```

The system prompt (`.opencode/modes/auto.md`) instructs the agent to:
- Operate autonomously without waiting for user confirmation
- Interpret denials from the risk judge as a signal to find a safer approach
- Complete the full task before stopping (not pause mid-task for confirmation)
- Report progress at meaningful checkpoints (not every tool call)

---

## State Management

**In-memory state** is a `Map<sessionID, AutopilotState>` closure — the established community pattern for sharing state across hooks safely across multiple concurrent sessions. The plugin closure initialises the map once; each hook looks up state by `input.sessionID` or `event.properties.sessionID`.

**Persisted state** lives in `.opencode/autopilot-state.json` (one file per session, keyed by session ID):

```json
{
  "sessionId": "...",
  "startedAt": "2026-05-25T10:00:00Z",
  "stepCount": 42,
  "callHistory": [
    { "tool": "bash", "argsHash": "abc123", "tier": 2, "decision": "ALLOW" },
    ...
  ],
  "denialCount": 1,
  "consecutiveDenials": 0,
  "activeConstraints": ["do not push"],
  "loopEvents": []
}
```

This file is:
- Written atomically on every step (rename-into-place pattern)
- Read on `session.created` for resumed sessions
- Injected into compaction context via `experimental.session.compacting`
- Deleted on clean session completion
- Preserved on crash/timeout for post-mortem inspection

---

## TUI Integration (Phase 1 Constraints)

Phase 1 (plugin) cannot modify the TUI directly. Workarounds for visibility:
- Use `tui.toast.show` to display risk judgments: `"[AUTO] bash → ALLOW (T3)"` and denials: `"[AUTO BLOCKED] git push — irreversible remote action"`
- **Do not use `tui.prompt.append` for the loop driver** — it is UI-only and does not trigger agent turns
- Log all events to `.opencode/autopilot.log` for external monitoring (`tail -f`)

Circuit breaker in Phase 1: when tripped, the plugin stops calling `client.session.prompt()` from the `session.idle` event handler and publishes a toast alert. The agent goes idle and waits for the user to either resume by typing or quit. This is adequate for Phase 1; Phase 2 adds an interactive [c]ontinue [q]uit prompt.

Phase 2 (core) will add a proper status bar indicator.

---

## Consequences

- Hook integration requires Bun's async support — Node.js plugin runners would need adaptation
- State file is a single point of failure — atomic writes prevent partial state corruption
- TUI visibility is limited in Phase 1; teams using CI/CD should monitor the log file
- The `experimental.session.compacting` hook is marked experimental and may change; the plugin must handle its absence gracefully
