# ADR-002: Risk Judge Architecture — Integrate Existing Models

- **Status:** Accepted (revised 2026-05-25)
- **Date:** 2026-05-25
- **Deciders:** Christian Haegele

---

## Context

For Tier 3 (boundary-crossing) tool calls, we need a mechanism to decide: allow or deny? The original decision considered building a secondary LLM judge from scratch, then revised to integrate existing open models. After further review, we also dropped sh-guard as a blocking layer (see Rejected Options below).

---

## Decision: Two-Layer Stack with Existing Open Models

```
Layer 1  →  LLM semantic judge (Llama Guard 3-1B or ShieldAgent)
Layer 2  →  Llama Prompt Guard 2-86M (prompt injection scan on tool outputs)
```

The previously proposed sh-guard "Layer 0" deterministic pre-filter has been removed. See Rejected Options.

---

## Layer 1: LLM Semantic Judge

Applied to all T3 tool calls (all `bash` calls + any structured tool call that crosses the trust boundary — see ADR-004).

The judge receives:
- User messages (stated intent)
- Proposed tool call: tool name + full arguments (including the complete bash command or script)
- Tool call history with **source-aware output inclusion** (see below)
- Trust boundary definition (writableRoots, allowedNetworkHosts, protected paths)

The judge does **not** receive:
- Agent reasoning / chain-of-thought
- OpenCode system prompt internals

### Source-Aware Output Inclusion

The injection risk is not uniformly distributed across tool output types. Blanket stripping (Claude Code's approach) discards valuable local context to defend against injection that only lives in remote sources. Blanket inclusion (Codex's approach) exposes the judge to adversarial content, which is a weaker guarantee when our default judge is a small 1B model rather than Sonnet 4.6.

We adopt a **source-aware policy**:

| Tool output source | Judge receives output? | Rationale |
|---|---|---|
| `read`, `grep`, `glob`, `list` | **Yes** | Local filesystem, trusted, high context value for decision quality |
| `bash` stdout from local-only commands | **Yes** | Trusted environment; essential for understanding agent progress |
| `webfetch` responses | **No — stripped** | Highest injection risk; remote, adversarial |
| `bash` stdout from remote-fetching commands (`curl`, `wget`, `git fetch`, `ssh`) | **No — stripped** | Treated same as webfetch |
| MCP tool outputs | **No — stripped** | External, potentially adversarial |

"Remote-fetching" detection: if the bash command contains `curl`, `wget`, `fetch`, `http`, `https`, `ssh`, `scp`, `rsync` (remote), or pipes from network tools, its stdout is stripped from the judge. Local bash commands (test runners, linters, compilers, git log/status/diff) are included.

**Why not blanket-strip (Claude Code)?** Our default judge is Llama Guard 3-1B — a small model with less adversarial robustness than Sonnet 4.6. The argument for structural immunity is stronger with a smaller model. However, the injection risk in a local coding agent is concentrated in remote tool outputs. Local bash stdout (test results, compiler errors, git status) provides essential context that reduces false positives significantly, and stripping it to defend against injection from local commands is disproportionate.

**Why not blanket-include (Codex)?** "Treat the transcript as untrusted" is a soft guarantee that must be reliably followed under adversarial pressure. With a 1B model as default judge, this is not a guarantee we can rely on. Structural immunity for the high-risk sources (remote content) is preferable.

**Prompt injection on tool outputs** is handled by Layer 2 (Llama Prompt Guard 2-86M), which scans all tool outputs before they reach the **main agent's** context — regardless of whether they were stripped from the judge. This protects the agent from injection independently of judge visibility.

**Escape hatch:** `autoMode.judgeIncludeRemoteOutputs: true` allows users running a more capable judge model (ShieldAgent 8B or a hosted frontier model) to opt into full output inclusion for better decision quality on remote-content-related actions.

**The judge evaluates effect/outcome, not syntax.** When given a bash command or script, the judge must reason about what it would *do* — which paths it would affect, whether those are inside or outside the trust boundary, whether the action is reversible — not match the command against a pattern list. This is the only approach that holds when an LLM uses Perl, Python, Node.js, or any other language to achieve the same effect as a blocked command.

### Output

```json
{
  "decision": "ALLOW" | "DENY",
  "rationale": "one sentence",
  "suggestedAlternative": "optional — what the agent should try instead"
}
```

### Model Selection

The judge uses **OpenCode's existing provider abstraction** (`@opencode-ai/sdk`) — the same auth, retry logic, and model-selection infrastructure as the primary agent. No separate HTTP client, no new API keys, no additional setup required.

**Default: cheapest/fastest model from the user's already-configured primary provider.**

| Primary provider | Default judge model | Approx. cost per call |
|---|---|---|
| Anthropic | `claude-haiku-4-5` | ~$0.0002 |
| OpenAI | `gpt-4o-mini` | ~$0.0002 |
| Google | `gemini-2.0-flash-lite` | ~$0.0001 |
| Other | Same model as primary agent | Varies |

For a typical autopilot session with 100 judge calls, total judge cost is **$0.01–$0.02**. The user pays with the API key they already have configured — zero additional setup.

The fallback to the primary agent's model for unknown providers is conservative but always correct: any model capable of running OpenCode's primary agent can handle the judge task.

**Capability note:** Hosted small models (Haiku, gpt-4o-mini) are significantly more capable than local 1B models at instruction following and resisting prompt injection. This means the source-aware output inclusion policy (see above) can lean more permissive on a hosted judge — the `autoMode.judgeIncludeRemoteOutputs` escape hatch is most relevant when using a hosted model.

**Override — any model, any provider OpenCode supports:**
```json
{
  "autoMode": {
    "judge": {
      "provider": "anthropic",
      "model": "claude-haiku-4-5"
    }
  }
}
```

`provider` and `model` accept any value OpenCode itself accepts, including providers configured with custom base URLs.

**Local model (zero marginal cost, air-gapped, privacy):**
```json
{
  "autoMode": {
    "judge": {
      "provider": "ollama",
      "model": "llama-guard3:1b"
    }
  }
}
```

Ollama is an existing OpenCode provider — no special handling needed. Hardware: ~0.75 GB VRAM (Q4) or ~2–3 GB RAM for CPU inference (~300–800ms on CPU, ~50–100ms on GPU). See ADR-004 for the `autoMode.bashFastScreen` option that makes CPU inference practical for interactive sessions.

### Failure Modes

| Failure | Behavior |
|---------|----------|
| Ollama not running | Fail-closed: deny + log error |
| Judge API timeout (> 5s) | Fail-closed: deny + log timeout |
| Unparseable judge response | Fail-closed: deny + log raw output |

Fail-closed is mandatory. A judge that is unreachable must never default to allowing actions.

---

## Layer 2: Prompt Injection Scan on Tool Outputs

**Model:** Llama Prompt Guard 2-86M  
**HuggingFace:** https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M  
**Architecture:** mDeBERTa-v3 encoder (fast CPU inference, ~92ms on A100, ~300ms on CPU)  
**License:** Llama 4 Community License  
**Output:** BENIGN or MALICIOUS + confidence score  

Layer 2 is distinct from Layer 1: Layer 1 evaluates **outbound** proposed actions; Layer 2 evaluates **inbound** tool outputs before they re-enter the agent's context.

**What it scans:** Tool outputs returning to the agent:
- Web fetch responses
- File contents when reading from new or external paths
- Bash stdout from commands that fetch remote content

**When MALICIOUS is detected:**
- Prepend a warning to the tool result, anchoring the agent back to its original task
- Log the detection with confidence score
- Do **not** block the output — blocking creates a denial vector for attackers who control content the agent reads

**Runs in parallel with tool execution**, not in the critical path before it.

---

## Rejected Options

### sh-guard as a blocking pre-filter

sh-guard is a rule-based AST classifier for shell commands. It was initially proposed as a fast deterministic pre-filter (Layer 0) that would hard-block dangerous bash commands before the LLM judge is invoked.

**Why it was rejected:**

Command-pattern blocking of bash invocations provides false security. An LLM that wants to delete files can use `perl -e 'unlink glob "/*"'`, a Node.js script, a Go binary, or any other executable available on the system. The same applies to every other category of "dangerous command": privilege escalation, network exfiltration, secret access. Blocking the most obvious form while leaving all equivalent forms open is worse than having no blocklist, because it creates a false confidence that the dangerous operation has been prevented.

**What sh-guard is still useful for:** As an optional signal enricher — sh-guard's output (risk score, MITRE ATT&CK tags, GTFOBins matches) can be appended to the judge's input as additional context. This gives the judge useful signals without relying on sh-guard to make the blocking decision. This is an optional enhancement, not part of the core architecture.

### Building a custom risk classifier from scratch

No fine-tuning required for v1. Llama Guard 3 with custom category injection and ShieldAgent cover the use case with existing weights.

---

## Consequences

- Plugin `package.json` has **no** sh-guard dependency and **no** Ollama dependency — the judge goes through OpenCode's existing provider client
- **Zero additional setup** for the common case: the judge defaults to the user's already-configured provider and its cheapest model
- Ollama + `llama-guard3:1b` is a supported option for local/offline use, documented in the README but not required
- The judge prompt template is version-controlled at `src/judge/policy-template.md` (structure) and `src/judge/policy.md` (risk taxonomy / outcome category definitions)
- `policy.md` is swappable via `autoMode.judgePolicy` config key — no code changes to adjust judgment behavior
- All judge decisions are logged with provider, model, decision, rationale, and whether outputs were stripped
- The source-aware output stripping policy (strip remote, include local) is the default; `autoMode.judgeIncludeRemoteOutputs: true` opts into full inclusion for users with capable hosted judges
