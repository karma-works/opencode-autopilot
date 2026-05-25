# ADR-001: Integration Layer — Plugin vs. Core

- **Status:** Accepted
- **Date:** 2026-05-25
- **Deciders:** Christian Haegele

---

## Context

OpenCode Autopilot needs to integrate with OpenCode's existing architecture. The fundamental question is: should autopilot be implemented as a plugin (using existing extension points) or as a modification to OpenCode's core codebase?

OpenCode provides two extension mechanisms relevant to autopilot:
1. **Mode definitions** — Markdown files or `opencode.json` entries that configure model, tool permissions, and system prompt
2. **Plugins** — JS/TS modules (run via Bun) with named hooks (`tool.execute.before`, `experimental.session.compacting`) and a unified `event` hook for session lifecycle events (`session.idle`, `session.created`, `session.compacted`, etc.)

---

## Decision Options

### Option A: Pure Plugin
Implement autopilot entirely as a plugin using existing hooks. The `auto` mode is defined in `opencode.json`; the risk judge runs in `tool.execute.before`; loop detection tracks state in plugin memory.

**Pros:**
- No fork of OpenCode required
- Ships immediately as an npm package / local plugin
- Can iterate independently of OpenCode release cycle
- Tests the hook API surface before proposing core changes

**Cons:**
- `tool.execute.before` cannot halt execution — it can throw to cancel, but cannot inject context or delay for async LLM judgment without blocking the event loop in a non-obvious way
- Loop detection state is per-plugin-instance; session compaction can reset it
- No TUI integration — cannot show mode indicator, step count, or risk judgments in the UI
- Mode definition in `opencode.json` cannot add new TUI keybindings

### Option B: Core Fork / Upstream PR
Modify OpenCode's core to add `auto` as a first-class mode with dedicated loop infrastructure, TUI indicators, and hook lifecycle events.

**Pros:**
- Full TUI integration (mode indicator, step counter, risk judgment display)
- Can add new lifecycle hooks specifically for autopilot (e.g., `automode.action.evaluating`, `automode.loop.detected`)
- Proper async risk judge integration in the main agent loop
- Survives session compaction (state managed by core, not plugin)

**Cons:**
- Requires upstream contribution or maintaining a fork
- Slower iteration cycle
- Risk of architectural conflict with OpenCode's active development

### Option C: Hybrid — Plugin PoC → Core PR (Recommended)

Phase 1: Plugin-based prototype to validate the full UX and iron out the risk classification logic, loop detection algorithms, and judge model integration. Ship as a community plugin.

Phase 2: Propose and contribute `auto` mode to OpenCode core, informed by lessons from the plugin prototype. The plugin prototype becomes the reference implementation and test suite.

---

## Decision

**Option C: Hybrid.**

The plugin prototype is the fastest path to a working, testable system. Once the design is validated, contributing to core is the right outcome — it gives us TUI integration and proper lifecycle hooks that plugins cannot achieve.

The plugin prototype deliberately constrains itself to hook APIs that the core implementation will also use, making the transition clean.

---

## Consequences

- Phase 1 (plugin) can ship without any OpenCode contributions
- Phase 1 is a complete, usable autopilot — not just a demo
- Phase 2 (core PR) will reference Phase 1 as prior art in the PR description
- The plugin continues to work for users on older OpenCode versions after the core feature ships
- All risk classification logic, judge prompts, and loop detection algorithms live in a shared library that both the plugin and core implementation import
