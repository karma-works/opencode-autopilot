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

**What the hook does:**
1. Receive proposed tool call (`tool_name`, `args`)
2. Run T4 blocklist check (synchronous, < 1ms)
3. Run risk classification (`classifyToolCall`) → T1/T2/T3/T4
4. For T1/T2: log to audit trail, allow execution (return without throwing)
5. For T3: invoke secondary LLM judge (async), await decision
   - ALLOW: log, allow execution
   - DENY: log denial, update circuit breaker counter, throw `ToolBlockedError` with rationale
6. For T4: throw `ToolBlockedError` immediately (no judge call)
7. Update loop detection state (step counter, call history)
8. Check loop detection conditions — if triggered, throw appropriate error

**Async in `tool.execute.before`:** OpenCode's plugin system runs Bun (which supports top-level async). The hook can `await` the judge LLM call. This is the correct approach — blocking is acceptable here because the alternative (allowing execution before the judge responds) defeats the purpose.

---

## Secondary Hooks

### `session.created`

Initialize autopilot state on session start:
- Load persisted state from `.opencode/autopilot-state.json` (for resumed sessions)
- Initialize step counter, call history ring buffer, start time
- Validate trust boundary configuration
- Log session start with configured parameters

### `session.idle`

Fire when the agent completes a turn and is waiting for input. In autopilot mode, the plugin intercepts this event to:
- Check if the session is "done" (agent said it completed the task) vs "waiting for input"
- If done: emit completion event, log summary, allow session to close
- If waiting for input: this should not happen in autopilot mode — emit a warning and inject a continuation prompt

### `session.compacted`

Fires after context compaction. The plugin must:
- Persist current loop detection state to `.opencode/autopilot-state.json`
- Verify state was saved correctly before allowing session to continue

### `experimental.session.compacting`

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
  "mode": {
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

All autopilot runtime state lives in `.opencode/autopilot-state.json`:

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
- Use `tui.toast.show` to display risk judgments: `"[AUTO] Bash: git push → ALLOW (T3)"`
- Use `tui.prompt.append` to inject circuit breaker messages into the conversation flow
- Log all events to `.opencode/autopilot.log` for external monitoring (`tail -f`)

Phase 2 (core) will add a proper status bar indicator.

---

## Consequences

- Hook integration requires Bun's async support — Node.js plugin runners would need adaptation
- State file is a single point of failure — atomic writes prevent partial state corruption
- TUI visibility is limited in Phase 1; teams using CI/CD should monitor the log file
- The `experimental.session.compacting` hook is marked experimental and may change; the plugin must handle its absence gracefully
