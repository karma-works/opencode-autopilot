# ADR-003: Loop Control — Detection, Termination, and Escalation

- **Status:** Accepted
- **Date:** 2026-05-25
- **Deciders:** Christian Haegele

---

## Context

A fully autonomous agent running in a loop without human approval is at risk of:
1. **Infinite loops** — repeating the same action indefinitely because the precondition never changes
2. **A-B alternation** — oscillating between two actions (A→B→A→B) that cancel each other
3. **Runaway cost** — exceeding budget limits via unchecked LLM call accumulation
4. **Denial spirals** — the risk judge blocks every proposed action, leaving the agent stuck

Loop detection is categorically a problem that the primary agent model cannot reliably solve: each repeated tool call appears locally justified from within the agent's context. External detection is mandatory.

---

## Decision

Implement **four orthogonal loop-control mechanisms**, all running outside the agent model:

### Mechanism 1: Hard Step Limit

A configurable ceiling on total LLM inference calls per autopilot session.

```json
{
  "autoMode": {
    "maxSteps": 100
  }
}
```

Default: 100 steps. When the limit is reached, the session terminates gracefully: the agent is given one final "summarize what you completed and what remains" turn, then the session ends with exit code 0 if the task was partially complete, non-0 if no meaningful progress was made.

### Mechanism 2: Identical-Call Repetition Detection

Track a sliding window of the last N tool calls with their exact arguments (serialized to JSON). If the same `(tool_name, args_hash)` tuple appears 3 or more times in the window without a different tool call in between, inject a synthetic tool error:

```
StuckLoopError: The tool call <tool_name> with these exact arguments has been called
3 times consecutively without progress. You appear to be in a loop. Review what 
you are trying to accomplish and choose a different approach.
```

Window size: 10 tool calls. Repetition threshold: 3 consecutive identical calls.

### Mechanism 3: A-B Alternation Detection

Track alternating patterns. If the pattern `(A, B, A, B)` appears where A and B are different `(tool_name, args_hash)` tuples, inject:

```
AlternatingLoopError: You are alternating between two actions without making 
progress. Action sequence detected: <A> → <B> → <A> → <B>. Reassess your approach.
```

Detection window: 8 calls. Trigger: 2 complete A-B cycles.

### Mechanism 4: Wall-Clock Timeout

A configurable hard time limit independent of call count.

```json
{
  "autoMode": {
    "timeoutMinutes": 30
  }
}
```

Default: 30 minutes. When triggered, the session receives a graceful shutdown signal. The agent gets one final summarization turn, then exits.

---

## Circuit Breaker: Denial Escalation

Separate from loop detection, a circuit breaker handles the risk judge denying too many actions:

- **3 consecutive DENY decisions** → emit `AutopilotCircuitBreaker` event → pause autonomous loop → prompt user to review
- **10 total DENY decisions in a session** → same trigger (protects against slow-burn spirals)

On circuit breaker trip:
1. Log all denied actions with rationales to `.opencode/autopilot.log`
2. Display summary in TUI: "Autopilot paused — N actions blocked. Review and press [c]ontinue or [q]uit."
3. User can: (a) resume autopilot, (b) switch to `build` mode for manual continuation, (c) quit

In headless/CI mode: circuit breaker trips cause immediate exit with code 2.

---

## State Management Across Compaction

Session compaction clears the agent's context window. Loop detection state must survive compaction to remain effective.

- Loop detection state (call history, step counter, start time) lives in the plugin/core autopilot module, not in the agent's context
- State is persisted to `.opencode/autopilot-state.json` on every step
- On compaction (`session.compacted` hook), state is reloaded from disk
- The `experimental.session.compacting` hook injects a summary of denied actions and loop events into the compaction prompt so the agent has context about past failures

---

## Consequences

- Step count is always visible in TUI status bar during autopilot sessions
- All loop events are logged to `.opencode/autopilot.log`
- Step limit, timeout, and window sizes are all configurable in `opencode.json`
- Headless mode exits with distinct exit codes: 0 (complete), 1 (circuit breaker), 2 (loop detected), 3 (timeout), 4 (step limit)
- Loop detection is unit-testable in isolation (pure function of call history)
