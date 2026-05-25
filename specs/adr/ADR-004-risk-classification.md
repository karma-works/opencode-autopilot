# ADR-004: Risk Classification Taxonomy

- **Status:** Accepted (revised 2026-05-25)
- **Date:** 2026-05-25
- **Deciders:** Christian Haegele

---

## Context

Every tool call in autopilot mode must be classified into a risk tier before execution. The classification determines the governance path: auto-approve, route to judge, or hard-block.

**Core constraint: bash semantics cannot be inferred from command text.**

An LLM can achieve any effect — deleting files, writing outside the working directory, exfiltrating secrets, escalating privileges — using any language or tool available on the system. A command-pattern blocklist on `bash` calls provides false security. Therefore:

- **Structured OpenCode tools** (read, write, edit, grep, glob, list, patch, webfetch) are classified by their explicit, well-defined arguments. Their semantics are fully known.
- **All `bash` tool calls are T3** without exception, regardless of the command's apparent simplicity. The LLM judge reasons about what the command *would do*, not what it looks like.

---

## Decision

Three tiers (T4 is removed — see below):

---

### Tier 1 — Read-Only (Structured Tools Only)

**Governance:** Auto-approve. Logged to audit trail only.

**Definition:** Structured tool calls that observe state without modifying it and have no observable side effects.

**Eligible tools and conditions:**

| Tool | T1 condition |
|------|-------------|
| `read` | Target path is within trust boundary |
| `grep` | Read-only search, target within trust boundary |
| `glob` | Read-only pattern match |
| `list` | Directory listing |
| `webfetch` GET | Host is in `autoMode.allowedNetworkHosts`; method is GET |

**Side-effect trap:** Some semantically "read" operations modify state. These are **not** T1:
- `webfetch` GET to hosts that track reads (analytics, email open tracking, API call counters)
- These cannot be reliably detected and should be T3 if the host is not in `allowedNetworkHosts`

**`bash` is never T1**, even for commands that appear read-only (`ls`, `cat`, `find`). The same shell session that runs `cat` could pipe its output to `curl`. Bash arguments are code, not data.

---

### Tier 2 — Reversible Local Writes (Structured Tools Only)

**Governance:** Auto-approve. Logged to audit trail with file diff snapshot (enabling rollback via `/undo`).

**Definition:** Structured tool calls that modify state within the trust boundary and are reversible via OpenCode's snapshot/undo system.

**Eligible tools and conditions:**

| Tool | T2 condition |
|------|-------------|
| `write` | Target path is within `autoMode.writableRoots` and not a protected path |
| `edit` | Same |
| `patch` | Same |
| `todowrite` | Always — agent's internal todo list |
| `webfetch` GET | Host is in `allowedNetworkHosts` AND is localhost/127.0.0.1 |

**Protected paths always excluded from T2** (even if within writableRoots):
- `.git/` internals
- `~/.ssh/`, `~/.gitconfig`, `~/.bashrc`, `~/.zshrc`, `~/.profile`
- `~/.config/opencode/`
- `/etc/`, `/usr/`, `/bin/`, `/sbin/`, `/lib/`, `/proc/`, `/sys/`, `/dev/`

Writes to protected paths are T3 (routed to judge) regardless of configuration.

**`bash` is never T2**, even for commands like `mkdir -p ./src` or `npm test`. Any bash call can execute arbitrary code and its effects cannot be bounded by inspecting its arguments. The LLM judge evaluates bash calls for their intended effect.

---

### Tier 3 — Requires Judge Evaluation

**Governance:** Route to LLM judge (ADR-002). Execute on ALLOW, block on DENY with rationale returned to agent.

**Definition:** Any tool call that cannot be guaranteed safe by inspecting its arguments alone.

**Includes everything not covered by T1/T2:**

- **All `bash` calls** — unconditionally, regardless of apparent simplicity
- Structured tool writes **outside** `writableRoots`
- Structured tool writes **to protected paths**
- `webfetch` POST/PUT/DELETE to any host
- `webfetch` GET to hosts not in `allowedNetworkHosts`

**The judge evaluates outcome, not syntax.** For a bash call, the judge considers:
- What paths would this command affect? Are they within the trust boundary?
- Does this command make network calls? To where?
- Is this action reversible within the session?
- Does this match any category of unconditionally prohibited outcomes?

The judge's custom category definitions (S15/S16/S17 in Llama Guard 3) define the unconditionally prohibited outcomes:
- **S15** — Trust boundary violation (filesystem)
- **S16** — External network state mutation
- **S17** — Irreversible remote action

These outcomes are blocked regardless of how they are achieved — whether by `rm`, a Perl script, a compiled binary, or any other means.

---

## Why T4 (Hard-Block) Was Removed

The previous design had a T4 tier: a hard-block list of specific command patterns (`rm -rf /`, `curl | bash`, etc.) that would be blocked without invoking the LLM judge.

**T4 was removed because it provides false security for `bash` calls.** Every T4 pattern has trivially equivalent alternatives in other languages or invocation forms. A T4 list on bash commands creates an illusion of safety while leaving all equivalent vectors open. The LLM judge (with S15/S16/S17 outcome categories) is the correct and complete gate.

**The one exception — structured tool protected paths:**
Writes to protected paths (`.git/`, `~/.ssh/`, etc.) via OpenCode's structured `write`/`edit` tools are still T3 (not promoted to T2) and will reliably be denied by the judge, because the judge receives the exact target path as a structured argument. This is reliable because the tool has precise semantics — unlike bash, where the "target" is embedded in arbitrary code.

**The circuit breaker replaces the T4 hard stop.** When the judge repeatedly denies actions, the circuit breaker (ADR-003) escalates to the user. This is more robust than a static blocklist: it catches novel dangerous patterns that T4 would have missed, and it handles evasion attempts that T4 was blind to.

---

## Classification Summary

| Tool call | Tier | Governance |
|-----------|------|------------|
| `read`, `grep`, `glob`, `list` within trust boundary | T1 | Auto-approve |
| `webfetch` GET to allowed host | T1 | Auto-approve |
| `write`, `edit`, `patch` within writableRoots, not protected | T2 | Auto-approve + snapshot |
| `todowrite` | T2 | Auto-approve |
| **`bash` — any call, any arguments** | **T3** | **LLM judge required** |
| Structured write outside writableRoots | T3 | LLM judge required |
| Structured write to protected path | T3 | LLM judge required |
| `webfetch` POST/PUT/DELETE | T3 | LLM judge required |
| `webfetch` GET to non-allowed host | T3 | LLM judge required |

---

## Bash Fast Pre-Screen (Performance Optimisation)

All bash calls are T3 and require a judge call. On a machine without a GPU, Llama Guard 3-1B runs at 300–800ms per call on CPU. A session with 50 bash commands adds 15–40 seconds of judge latency — borderline tolerable for an autonomous background loop, but noticeable.

To reduce this overhead, a **fast pre-screen** (pure TypeScript, < 1ms, no model call) identifies bash commands that are unambiguously read-only, local, and low-injection-risk. Matching commands are logged as "fast-screened T2" and bypass the judge call.

**Pre-screen allowlist (command must match one of these AND contain no pipes `|`, redirects `>`, or subshell operators `$()` `` ` ``):**

```
# Git read-only
git log, git status, git diff, git show, git branch, git tag, git stash list

# Filesystem inspection
ls, find, cat, head, tail, wc, stat, file, du, df, tree

# Environment inspection
echo, pwd, env, which, type, printenv

# Test runners (read-only effect — run tests, don't deploy)
npm test, npm run test, npx jest, pytest, cargo test, go test, make test,
bundle exec rspec, dotnet test

# Type checkers and linters (read-only)
tsc --noEmit, eslint (without --fix), prettier --check, mypy, pyright, rubocop (without -a)
```

**Hard exclusions from pre-screen regardless of command:** any command containing `curl`, `wget`, `fetch`, `http`, `ssh`, `scp`, `rsync`, `nc`, `ncat`, environment variable assignments, `sudo`, `su`, `chmod`, `chown`, `rm`, `mv`, `cp`, `mkdir`, `touch`, `install`, `npm install`, `pip install`, `gem install`, `cargo install`, `brew`.

**This is a performance optimisation, not a security boundary.** The pre-screen does not prevent a determined LLM from embedding a destructive action inside a command that matches the allowlist pattern. It reduces judge call volume for the overwhelmingly common case of genuinely benign read-only bash. The judge remains the security gate for everything that doesn't fast-screen.

The pre-screen is **disabled by default** and must be opted in via `autoMode.bashFastScreen: true`. Users on machines with a capable GPU (where judge latency is 50–100ms) do not need it.

---

## Consequences

- Classification for structured tools is a pure, fast function of the tool name + target path
- All `bash` calls require a judge invocation unless fast-screen is enabled and the call matches
- Judge latency per T3 call: ~50–100ms (GPU), ~300–800ms (CPU) for the default 1B model
- The audit log records tier classification and whether fast-screen was applied for every call
- Users can promote specific `webfetch` GET hosts from T3 to T1 by adding them to `allowedNetworkHosts`
- Users can promote specific structured tool write targets from T3 to T2 by expanding `writableRoots`
- `bash` cannot be promoted to T1 or T2 via configuration — only fast-screen (opt-in) provides any bypass
