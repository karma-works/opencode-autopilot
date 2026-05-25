# OpenCode Autopilot: Implementation Plan

> Status: Draft  
> Date: 2026-05-25  
> Depends on: vision.md, ADR-001 through ADR-006

---

## Overview

Three phases. Phase 1 ships a working autopilot as a community plugin. Phase 2 proposes it to OpenCode core. Phase 3 handles hardening and ecosystem integration.

```
Phase 1: Plugin PoC          (weeks 1–4)  → working autopilot as plugin
Phase 2: Core Integration    (weeks 5–10) → upstream PR to OpenCode
Phase 3: Hardening           (weeks 11–14) → polish, security, ecosystem
```

---

## Phase 1: Plugin-Based Prototype

### Goal
Ship a complete, production-usable autopilot as an OpenCode plugin. All core logic (risk classification, judge integration, loop detection) lands here and is tested independently of core.

### Deliverables

#### 1.1 Project Scaffold

```
opencode-autopilot/
  src/
    index.ts               # Plugin entry point
    classifier/
      tier.ts              # Risk tier types and classification logic
      t4-blocklist.ts      # T4 hard-block patterns
      classify.ts          # classifyToolCall() pure function
    judge/
      client.ts            # Secondary LLM judge client
      prompt.md            # Judge prompt template (version-controlled)
      types.ts             # JudgeDecision type
    loop/
      detector.ts          # Loop detection (all 4 mechanisms)
      state.ts             # AutopilotState type and persistence
    trust/
      boundary.ts          # Trust boundary evaluation
      protected-paths.ts   # T4 protected path list
    audit/
      logger.ts            # Structured audit log writer
  modes/
    auto.md               # System prompt for auto mode
  test/
    classifier.test.ts
    loop.test.ts
    judge.test.ts
    trust.test.ts
  opencode.json           # Mode definition + autoMode config defaults
  package.json
  README.md
```

#### 1.2 Risk Classifier (`src/classifier/`)

Pure function: `classifyToolCall(tool: string, args: Record<string, unknown>, boundary: TrustBoundary): Tier`

Test coverage requirements:
- All built-in OpenCode tools classified correctly
- All border cases from ADR-004 table covered
- T4 blocklist: 100% pattern coverage
- Edge cases: symlinks, relative paths, environment variable expansion in bash args

#### 1.3 Judge Stack (`src/judge/`)

Three-layer stack using existing open models (see ADR-002 and `research/risk-judge-models-huggingface.md`):

```typescript
interface JudgeDecision {
  decision: "ALLOW" | "DENY";
  rationale: string;
  layer: "sh-guard" | "llm-judge" | "circuit-breaker";
  suggestedAlternative?: string;
}

// Layer 1: sh-guard AST pre-filter (bash tool calls only)
function runShGuard(command: string): ShGuardResult  // npm: sh-guard

// Layer 2: LLM semantic judge (configurable model via Ollama or API)
async function runLLMJudge(
  userMessages: Message[],
  toolCallHistory: ToolCallSummary[],  // no tool outputs — injection defense
  proposedCall: ProposedToolCall,
  trustBoundary: TrustBoundary,
  judgeConfig: JudgeConfig,
): Promise<JudgeDecision>

// Layer 3: Prompt injection scan on tool outputs (parallel with execution)
async function scanForInjection(toolOutput: string): Promise<InjectionScanResult>
// Model: Llama Prompt Guard 2-86M or ProtectAI DeBERTa v2
```

**Default judge model:** `llama-guard3:1b` via local Ollama — zero marginal cost, no API key.  
**Alternative:** `thu-coai/ShieldAgent` via HuggingFace Inference API for higher accuracy.  
**Setup requirement:** `ollama pull llama-guard3:1b` (documented in plugin README).

Note: sh-guard is **not** used as a blocking layer (see ADR-002 Rejected Options). All bash calls go to the LLM judge for semantic outcome evaluation.

The LLM judge client:
- Formats the Llama Guard 3 chat template with custom S15/S16/S17 category definitions for CWD boundary / network / irreversible remote actions
- Fails-closed on timeout (> 5s) or parse failure: returns `DENY` with rationale "Judge unavailable"
- Retries once on network error before failing-closed

#### 1.4 Loop Detector (`src/loop/`)

```typescript
interface LoopDetectionResult {
  detected: boolean;
  type?: "repetition" | "alternation" | "step-limit" | "timeout";
  message?: string;
}

function detectLoop(state: AutopilotState, newCall: ToolCallSummary): LoopDetectionResult
```

All four mechanisms (ADR-003) implemented as independent checks within this function. Unit-tested against crafted call sequences.

#### 1.5 Plugin Entry Point (`src/index.ts`)

```typescript
export const AutopilotPlugin = async ({ project, client, $, directory }) => {
  const config = loadAutoModeConfig(project);
  const state = await loadOrInitState(directory, client.session.id);

  return {
    "tool.execute.before": async (input) => {
      // 1. Classify
      // 2. T4 → throw immediately
      // 3. T3 → await judge → throw on DENY
      // 4. T1/T2 → log, allow
      // 5. Update loop state
      // 6. Check loop detection → throw on detection
    },
    "session.created": async () => { /* init state */ },
    "session.idle": async () => { /* check if done vs stuck */ },
    "session.compacted": async () => { /* persist state */ },
    "experimental.session.compacting": async (input, output) => {
      /* inject denial history and constraints into compaction prompt */
    },
  };
};
```

#### 1.6 Auto Mode System Prompt (`modes/auto.md`)

The system prompt instructs the agent to:
- Operate autonomously without waiting for per-action confirmation
- Treat `ToolBlockedError` as a signal to find a safer alternative approach
- Report progress at meaningful checkpoints (task complete, major decision point, blocked)
- Complete the full task before stopping
- Escalate to the user only when genuinely stuck (not just when one approach fails)

#### 1.7 Tests

- Unit tests for classifier, loop detector, trust boundary
- Integration test: mock OpenCode session, run a 10-step sequence, verify tier classifications and judge calls
- Adversarial tests: prompt injection payloads in synthetic tool outputs — verify judge is not influenced

### Phase 1 Success Criteria

- [ ] Plugin installs and activates via `opencode.json` `plugin` list
- [ ] `auto` mode is selectable in OpenCode
- [ ] T4 blocklist prevents all listed patterns
- [ ] Secondary LLM judge is called for T3 actions and not called for T1/T2
- [ ] Loop detection fires within 3 identical calls
- [ ] Circuit breaker pauses autopilot after 3 consecutive denials
- [ ] Audit log is written to `.opencode/autopilot.log`
- [ ] Headless mode exits with correct exit codes

---

## Phase 2: Core Integration

### Goal
Contribute `auto` mode as a first-class mode to OpenCode core, with proper TUI integration and lifecycle hooks that plugins cannot provide.

### Prerequisites
- Phase 1 plugin is shipped and battle-tested (min 4 weeks of real use)
- OpenCode maintainers have reviewed the approach (pre-PR discussion in GitHub issues)
- Core hook API for `automode.*` lifecycle events is agreed upon

### Deliverables

#### 2.1 New Lifecycle Hooks

Propose and implement new hooks that the plugin prototype revealed as necessary:

```typescript
"automode.action.classifying"   // before classification
"automode.action.evaluating"    // before judge call  
"automode.action.allowed"       // after allow decision
"automode.action.denied"        // after deny decision
"automode.loop.detected"        // on loop detection
"automode.circuitbreaker.trip"  // on circuit breaker
"automode.session.complete"     // on task completion
```

These hooks allow third-party plugins to extend autopilot behavior (e.g., custom notifications, custom denial handling).

#### 2.2 TUI Status Bar Integration

- Mode indicator: `[AUTO]` in status bar with current step count: `[AUTO 42/100]`
- Risk tier indicator: brief flash showing tier of last action: `T2 ✓` / `T3 ✓` / `T3 ✗`
- Circuit breaker state: `[AUTO PAUSED — 3 denials]` with `[c]ontinue [q]uit [b]uild-mode` prompt
- Trust boundary summary accessible via new `/trust` command

#### 2.3 Core Mode Registration

Register `auto` as a built-in mode alongside `build` and `plan`:
- First-class menu item in TUI mode selector
- Keybinding (e.g., Ctrl+Shift+A) for mode switch
- Persisted in session state so compaction doesn't lose mode context

#### 2.4 Async Risk Judge in Agent Loop

Integrate the risk judge into the agent's tool execution path at the core level:
- Eliminates the event-loop blocking of the plugin approach
- Proper async/await without Bun-specific workarounds
- Judge calls are cancellable (Ctrl+C cancels pending judge call, not just the tool call)

#### 2.5 Migrate Plugin Logic to Core Package

The Phase 1 classifier, loop detector, and state manager move to OpenCode's core packages. The Phase 1 plugin becomes a thin wrapper that calls into core — maintaining backward compatibility for users on older versions.

### Phase 2 Success Criteria

- [ ] `auto` mode appears in TUI mode selector without any plugin
- [ ] Status bar shows step count and last action tier
- [ ] Circuit breaker UI is interactive (not just a toast)
- [ ] New `automode.*` lifecycle hooks are documented and tested
- [ ] Existing Phase 1 plugin continues working as a compatibility shim

---

## Phase 3: Hardening and Ecosystem

### Goal
Security hardening, observability, and ecosystem integrations that make autopilot production-ready for teams.

### Deliverables

#### 3.1 Prompt Injection Hardening

- Input probe: scan tool outputs for prompt injection patterns before they enter the agent's context (Layer 1 from Claude Code's design)
- Adversarial test suite: known prompt injection payloads from public research
- Automated regression testing against injection corpus

#### 3.2 CI/CD Integration

- GitHub Actions example workflow
- Exit code documentation
- `--json` event stream for pipeline consumption
- Docker container reference configuration with appropriate sandbox

#### 3.3 Observability

- OpenTelemetry traces for each autopilot session (step count, tier distribution, denial rate, judge latency)
- Grafana dashboard template
- Alert rules: high denial rate, loop detection frequency, judge availability

#### 3.4 Custom Judge Model Support

- Documentation for bringing a fine-tuned risk classifier model
- Example: using `codex-auto-review1` style specialized model instead of general-purpose Haiku
- Evaluation harness for comparing judge model performance

#### 3.5 Trust Boundary Profiles

Pre-built trust boundary profiles for common scenarios:
- `strict`: No network, writableRoots = `src/` only
- `standard`: CWD writes, localhost network, GitHub API
- `open`: CWD writes, all read-only network, outbound POST to configured hosts

---

## Key Technical Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| OpenCode plugin API changes break Phase 1 | Medium | Pin to tested OpenCode version; integration tests catch regressions |
| Secondary LLM judge latency degrades UX | Medium | Use fastest available model; 5s timeout with fail-closed |
| `experimental.session.compacting` hook removed | Low | Graceful fallback: inject constraints into next user prompt instead |
| Judge prompt jailbroken via crafted tool description | Low | Judge prompt hardening; adversarial test suite |
| Loop detection false positives (legitimate repeated calls) | Medium | Tunable thresholds; window size configurable; identical-args requirement |
| OpenCode core PR rejected by maintainers | Low | Pre-PR discussion; Phase 1 proves the concept; plugin remains viable |

---

## Open Questions (to resolve before Phase 1 code)

1. **Judge model selection UX:** Should the plugin auto-select the cheapest available model, or require explicit config? Lean toward auto-select with a warning if no fast model is available.

2. **T3 → T2 elevation via config (`autoMode.autoApprovePatterns`):** How specific must the pattern be to avoid accidental elevation? Exact tool+args pattern required, or globs allowed?

3. **Conversational trust narrowing:** How do we detect "don't push" in free-form user messages? Keyword matching is fragile; running a classification LLM call on every user message is expensive. Consider: only parse explicit constraint phrases at session start.

4. **Multi-agent mode:** When the primary agent delegates to subagents, does autopilot mode apply to subagents? Proposed: yes, with the same risk judge but the subagent's delegated task as the stated intent.

5. **Cost accounting:** Should autopilot track and display judge model costs separately from primary agent costs? Useful for teams managing budgets.
