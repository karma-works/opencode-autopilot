# OpenCode Autopilot — Specs

Design documentation for the OpenCode `auto` mode — a first-class autopilot that loops autonomously while a secondary LLM handles risk mitigation behind the scenes.

---

## Documents

### Strategy

| Document | Description |
|----------|-------------|
| [vision.md](vision.md) | Why we're building this, what it does, success criteria, and user stories |
| [implementation-plan.md](implementation-plan.md) | Three-phase plan: Plugin PoC → Core Integration → Hardening |

### Architecture Decision Records

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-001](adr/ADR-001-integration-layer.md) | Integration Layer — Plugin vs. Core | Accepted |
| [ADR-002](adr/ADR-002-risk-judge-architecture.md) | Risk Judge Architecture — Rule-Based vs. Secondary LLM | Accepted |
| [ADR-003](adr/ADR-003-loop-control.md) | Loop Control — Detection, Termination, and Escalation | Accepted |
| [ADR-004](adr/ADR-004-risk-classification.md) | Risk Classification Taxonomy | Accepted |
| [ADR-005](adr/ADR-005-trust-boundary.md) | Trust Boundary Definition | Accepted |
| [ADR-006](adr/ADR-006-hook-integration.md) | Hook Integration Strategy | Accepted |

---

## Research

Background research that informed these decisions is in [`../research/`](../research/):

- [OpenCode current state](../research/opencode-current-state.md) — Plugin system, hooks, modes, architecture
- [Autopilot patterns across tools](../research/autopilot-patterns-across-tools.md) — Claude Code, Codex CLI, GitHub Copilot CLI
- [Risk judge models on HuggingFace](../research/risk-judge-models-huggingface.md) — Comparison of sh-guard, ShieldAgent, TS-Guard, Llama Guard 3, Llama Prompt Guard 2, ProtectAI DeBERTa

---

## Key Design Decisions (TL;DR)

1. **Phase 1 is a plugin, Phase 2 is core** — fastest path to a working system without blocking on upstream contributions (ADR-001)

2. **Two-layer judge stack using existing open models** — Llama Guard 3-1B via Ollama or ShieldAgent 8B as the semantic LLM judge + Llama Prompt Guard 2-86M for injection scan on tool outputs. No command-pattern blocklist; judge reasons about outcome/effect. No custom model built. (ADR-002)

3. **Loop detection is external to the model** — 4 mechanisms: step limit, repetition detection, A-B alternation, wall-clock timeout. Models cannot detect their own loops (ADR-003)

4. **Four risk tiers** — T1 (read-only, auto-approve) → T2 (reversible local, auto-approve) → T3 (boundary-crossing, route to judge) → T4 (irreversible, hard-block) (ADR-004)

5. **Trust boundary = smallest set that lets the task complete** — CWD by default, configurable `writableRoots` and `allowedNetworkHosts`, protected paths unconditional (ADR-005)

6. **`tool.execute.before` is the primary integration point** — with `session.compacted` and `experimental.session.compacting` for state persistence across context windows (ADR-006)

---

## Status

All ADRs are in **Accepted** status. Implementation has not started. Next step: scaffold Phase 1 plugin project.
