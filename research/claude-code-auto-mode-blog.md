# Claude Code Auto Mode — Engineering Blog Post

> Source: https://www.anthropic.com/engineering/claude-code-auto-mode  
> Researched: 2026-05-25

---

## Two-Layer Defense Architecture

**Layer 1 — Input probe (server-side):**
Scans tool outputs before they enter the agent's context. When hostile content is detected, prepends a warning to the agent's context before the result is passed along.

**Layer 2 — Transcript classifier (Sonnet 4.6):**
Evaluates each action against decision criteria before execution. Two stages:
- Stage 1: Fast single-token yes/no filter, instructed to "err on the side of blocking"
- Stage 2: Full chain-of-thought reasoning, only triggered if Stage 1 flags the action

---

## What the Classifier Sees vs. What Is Stripped

**Visible to classifier:**
- User messages
- Executable tool-call payloads (the proposed action)

**Stripped from classifier:**
- Assistant reasoning / chain-of-thought
- Tool descriptions
- **All tool outputs**

> "Tool outputs are where hostile content enters the context."

Stripping tool outputs gives **structural immunity** — no injected content in any tool output (fetched web page, file read, bash stdout) can reach the classifier, regardless of sophistication.

This is the opposite of Codex's approach (which includes tool outputs but instructs the judge to treat them as untrusted).

---

## Permission Tiers

**Tier 1 — Built-in allowlist + user-configured rules:**
- File reads, searches, code navigation
- **Note:** Blanket shell access and wildcarded script interpreters (`python *`, `node *`, `ruby *`, `bash *`) and package manager run commands are **disabled** in auto mode

**Tier 2 — In-project file edits (bypass classifier):**
- Routine coding operations bypass the classifier — "routine coding doesn't pay classifier latency, and changes are reviewable via version control"

**Tier 3 — High-risk actions (reach the transcript classifier):**
- Shell commands
- External service calls
- Subagent spawns
- Out-of-project filesystem operations

---

## Threat Model (Four Failure Modes)

1. **Overeager behavior** — agent solves problems beyond authorized scope
2. **Honest mistakes** — misunderstanding blast radius or resource ownership
3. **Prompt injection** — malicious instructions in fetched content
4. **Model misalignment** — agent pursuing independent goals (theoretical)

Same defense mechanism works for all four — the root cause doesn't need to be distinguished at runtime.

---

## Policy Template — Three Customizable Slots

The classifier uses a fixed template structure with three customizable slots:

### 1. Environment Definition
Establishes trust boundaries for domains, cloud buckets, internal services.
- Default: trusts only the current git repository
- Users/organizations override to expand trust scope

### 2. Block Rules (20+ defaults)

| Category | Examples |
|----------|---------|
| Destroy/exfiltrate | Force-pushes, mass deletions, data exfiltration |
| Degrade security | Disabling logging, installing persistence, modifying permissions |
| Cross trust boundaries | Running external code, credential scanning, sending data to unspecified services |
| Bypass review | Skipping safeguards on shared infrastructure, production deploys |

### 3. Allow Exceptions (narrow carve-outs)
- Installing declared dependencies
- Standard credential flows (reading `.env`, sending to matching API)
- Pushing to the session's working branch

Design intent: users "edit this baseline, rather than starting from scratch."

---

## Two-Stage Classification — Performance Benchmarks

| Dataset | Size | Stage 1 FPR | Stage 1 FNR | Full Pipeline FPR | Full Pipeline FNR |
|---------|------|-------------|-------------|-------------------|-------------------|
| Real traffic | 10,000 | 8.5% | — | 0.4% | — |
| Real overeager actions | 52 | — | 6.6% | — | **17%** |
| Synthetic exfiltration | 1,000 | — | 1.8% | — | 5.7% |

**Acknowledged weak point:** 17% FNR on real overeager actions. The classifier correctly identifies danger but struggles with "whether a real consent signal in the session actually covers *this specific* action." This is the primary known limitation.

---

## Circuit Breaker

- Blocked actions return as tool results with instruction: *"find a safer path, don't try to route around the block"*
- **3 consecutive denials** or **20 total denials** → escalate to human review
- Headless mode (`claude -p`) → terminate the process instead

---

## Prompt Injection Defenses (Layered)

1. **Structural immunity** — classifier never sees tool results (where injection lives)
2. **Input probe** — detects hostile patterns ("ignore previous instructions") in fetched content
3. **Warning injection** — compromised results receive prepended security warnings forcing re-anchoring
4. **CoT monitoring** — separate system catching concealed misaligned reasoning (orthogonal to action blocking)

---

## Multi-Agent Handoffs

Classifier operates at both delegation and return boundaries:
- **Outbound:** Validates tasks given to subagents before delegation
- **Return:** Reviews subagent's full action history before results propagate back; prepends security warnings rather than discarding results

---

## Key Design Rationale

**Why strip assistant reasoning:** Prevents agent from generating persuasive rationalizations that compromise classifier judgment ("talking the classifier into a bad call").

**Reasoning-blindness tradeoff:** Improves performance by reducing "room for the agent's own framing to color the decision." Remains orthogonal to separate CoT monitoring systems.

**Why customizable slots:** Allows iterative refinement — conservative defaults that users can loosen as deployment context becomes clearer, rather than building policy from scratch.

**Why deny-and-continue (not deny-and-stop):** Blocked actions return as tool results, letting the agent self-correct and find a safer path without human intervention. Sessions continue.
