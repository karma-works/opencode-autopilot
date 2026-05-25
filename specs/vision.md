# OpenCode Autopilot: Vision

> Status: Draft  
> Date: 2026-05-25  
> Authors: Christian Haegele

---

## Problem Statement

OpenCode's current `build` and `plan` modes require constant human involvement at every tool call boundary. This friction is intentional for routine interactive use, but it fundamentally limits OpenCode's utility for:

- Long-running, multi-step engineering tasks where constant approval is impractical
- Headless CI/CD environments where there is no human operator
- Power users who want to delegate a full task and return to results
- Workflows where the cost of interruption (context switch, re-engagement) exceeds the risk of the autonomous action

Other leading CLI agents — Claude Code, OpenAI Codex CLI, and GitHub Copilot CLI — have each independently shipped "autopilot" or "auto" modes that address this gap. OpenCode lacks a first-class equivalent.

---

## Vision

**OpenCode Autopilot is a first-class `auto` mode that runs the agent in a continuous autonomous loop, while a secondary LLM judges the risk of boundary-crossing actions behind the scenes — making OpenCode as autonomous as the user's risk tolerance allows.**

The mode integrates at the same level as `plan` and `build`: selectable from the TUI, configurable in `opencode.json`, and composable with the existing agent/mode/plugin system. It is not a bolt-on script — it is a first-class citizen of the OpenCode runtime.

---

## Goals

### Primary Goals

1. **Autonomous loop** — The agent runs continuously without per-tool-call interruption until the task is complete, a blocking problem is encountered, a loop is detected, or a step/time limit is reached.

2. **Secondary LLM risk judge** — A configurable secondary LLM model evaluates boundary-crossing actions (Tier 3 operations) before they execute. The user chooses the model; the architecture handles the separation of concerns.

3. **Four-tier risk classification** — Every tool call is classified into one of four risk tiers:
   - **T1 (Read-only):** Auto-approved, logged only
   - **T2 (Reversible local):** Auto-approved with audit trail
   - **T3 (Boundary-crossing):** Routed to secondary LLM judge
   - **T4 (Irreversible/destructive):** Hard-blocked

4. **External loop detection** — Loop detection runs outside the model. Repetition detection, A-B alternation detection, step limits, and wall-clock timeouts all fire independently of the agent's self-assessment.

5. **Circuit breakers** — Escalate to human review when the secondary LLM denies too many actions in a row, preventing runaway denial spirals.

6. **First-class UX** — Mode is selectable in the TUI, visible in session status, shows step count and risk judgments in real time. Users can interrupt with standard controls (Ctrl+C) or demote to `build` mode mid-session.

### Secondary Goals

7. **Configurable trust boundary** — Users define `autoMode.writableRoots` and `autoMode.allowedNetworkHosts`; defaults are the current working directory and no external network.

8. **Prompt injection defense** — The secondary LLM judge receives only user messages and tool call descriptions — never tool outputs or agent reasoning — preventing injected payloads from influencing the judge.

9. **Headless support** — Autopilot can run non-interactively for CI/CD use cases, with structured JSON event output and hard termination on circuit breaker trips.

10. **Pluggable judge model** — The secondary LLM judge model is configurable. Default: smallest capable model from the user's configured provider. Power users can swap in a purpose-built risk-classifier model.

---

## Non-Goals

- **This is not a jailbreak.** Autopilot does not remove safety constraints — it automates the approval workflow with a secondary LLM. The T4 hard-block list remains unconditional.
- **This is not an OS-level sandbox.** We rely on OpenCode's existing trust boundary configuration, not kernel-level isolation (seatbelt, bwrap). OS sandboxing may be added in a future phase.
- **This is not a new agent architecture.** Autopilot reuses the existing agent loop. The secondary LLM judge is a standalone evaluator, not a new agent.
- **This is not a headless replacement.** The primary interface remains the TUI. Headless support is a secondary target.

---

## Success Criteria

| Metric | Target |
|--------|--------|
| Autonomous task completion rate (no human interrupt) | ≥ 85% for typical coding tasks |
| False positive rate (blocked safe actions) | < 5% |
| False negative rate (auto-approved dangerous actions) | < 1% |
| Loop detection latency | < 3 identical calls before detection |
| Human interrupts vs manual approval mode | Reduced ≥ 10x |
| Mode selection in TUI | Single keypress / first-class menu item |
| CI/CD headless run success | Agent exits 0 on task complete, non-0 on circuit breaker |

---

## User Stories

**Power user — delegate and step away:**
> "I have a large refactoring task. I want to hand it to OpenCode in auto mode and check back in an hour. If it hits something risky, I want it to either handle it intelligently or stop and wait for me — not silently skip it."

**CI/CD engineer — autonomous pipeline step:**
> "I want to run OpenCode autopilot as a GitHub Actions step that automatically fixes lint errors, updates dependencies, and opens a PR — without manual approval on every file write."

**Security-conscious team lead — constrained autonomy:**
> "I want auto mode but with network calls blocked and writes restricted to `src/` only. The secondary LLM judge should block anything that touches secrets or config files."

**Skeptic — try before trusting:**
> "I want to see auto mode in action without giving it full permissions. Let it run in build mode today; I'll switch to auto if it earns it."

---

## Analogues and Prior Art

| Tool | Mode | Key Differentiator |
|------|------|--------------------|
| Claude Code | `auto` | Two-stage classifier (fast filter + CoT reasoning); Sonnet 4.6 as judge |
| OpenAI Codex CLI | `auto_review` | Purpose-built `codex-auto-review1` model; OS-level sandbox |
| GitHub Copilot CLI | `autopilot` | Per-continuation cost visibility; `--max-autopilot-continues` limit |
| **OpenCode Autopilot** | `auto` | **Pluggable judge model; first-class mode integration; provider-agnostic** |

OpenCode's advantage: provider-agnostic architecture means the secondary LLM judge can use any model the user has configured — Anthropic, OpenAI, Gemini, or a local model. No vendor lock-in on the safety layer.
