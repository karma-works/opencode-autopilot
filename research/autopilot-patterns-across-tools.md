# Autopilot Mode Architecture in Major CLI Coding Agents

> Research conducted: 2026-05-25  
> Sources: Anthropic Engineering blog, OpenAI Alignment blog, Codex docs, GitHub Copilot docs, DeepWiki

---

## 1. Claude Code Auto Mode

### Permission Mode Spectrum

| Mode | What runs without asking |
|------|--------------------------|
| `default` | Reads only |
| `plan` | Reads only (then proposes changes) |
| `acceptEdits` | Reads, file edits, common FS commands within working dir |
| `dontAsk` | Only pre-approved tools (deny everything else; for CI) |
| `auto` | Everything, with background safety checks from classifier model |
| `bypassPermissions` | Everything, no checks (alias: `--dangerously-skip-permissions`) |

### Auto Mode: Two-Layer Defense

**Layer 1 — Input: Prompt-Injection Probe (server-side)**
- Every tool output (file reads, web fetches, shell stdout, MCP responses) passes through a probe before entering context
- Detects hijacking attempts (e.g., "ignore previous instructions" in a file the agent read)
- Prepends a warning flag — does not block, contextualizes
- Agent re-anchors on user's original intent

**Layer 2 — Output: Transcript Classifier (runs on Sonnet 4.6)**
- Separate Sonnet 4.6 instance evaluates each tool call before execution
- Stage 1 (fast filter): Single-token yes/no — aggressively errs toward blocking
  - 8.5% false positive rate, 6.6% false negative rate on genuinely dangerous actions
- Stage 2 (chain-of-thought): Only triggered if Stage 1 flags — uses full CoT reasoning
  - Cuts false positives from 8.5% → 0.4%; costs ~17% false negatives on overeager behaviors

**Critical design: Reasoning blindness**
- Classifier sees only: user messages + agent tool calls + CLAUDE.md content
- Agent's own reasoning + tool outputs are stripped
- Malicious payload in a file cannot influence the classifier — it never sees the payload

### Default Allow/Block Rules

**Blocked:**
- `curl | bash` and download-and-execute patterns
- Sending data to external endpoints (exfiltration)
- Production deploys and DB migrations
- Mass deletions on cloud storage
- IAM/repo permission grants
- Force-push or push directly to `main`
- `rm -rf /` and `rm -rf ~` (circuit-breaker, even in `bypassPermissions`)

**Allowed:**
- Local file ops in working directory
- Installing deps from declared lock files/manifests
- Reading `.env` and sending credentials to matching API
- Read-only HTTP requests
- Pushing to current branch or branches Claude created

### Denial Handling

- Blocked actions return tool results with rationale + instruction to find safer alternative
- **Circuit breakers:** 3 consecutive denials OR 20 total → escalate to human review
- In headless mode (`-p`): repeated blocks abort session
- `/permissions` shows "Recently Denied"; press `r` to manually retry with override

### Subagent Handling

Classifier checks at three points:
1. At spawn time (evaluates delegated task description)
2. During execution (each subagent action goes through classifier)
3. On completion (reviews full action history; prepends security warning if flagged)

---

## 2. OpenAI Codex CLI

### Two Orthogonal Axes: Sandbox vs Approval Policy

**Sandbox levels (`--sandbox`):**
- `read-only`: No writes, no network
- `workspace-write` (default Auto): CWD reads/writes; `.git`, `.agents`, `.codex` always read-only
- `danger-full-access`: No OS-level restrictions

**Platform enforcement:**
- macOS: Apple Seatbelt via `sandbox-exec` with dynamically generated Sandbox Profile Language scripts
- Linux: `bwrap` (bubblewrap) + `seccomp` syscall filtering + Landlock + user/PID/network namespace isolation
- Windows: Restricted tokens + ACL manipulation via `create_process_as_user`

**Approval policies:**
- `untrusted`: Auto-approves safe reads; requires approval for state-mutating commands
- `on-request` (default Auto): Routes boundary-crossing requests to user/reviewer
- `never`: Disables all approval prompts (sandbox still active)

**YOLO flag:** `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) — removes both sandbox and approval policies.

### Auto-Review: Secondary LLM Judge

Released April 2026. The most mature secondary-LLM-as-judge implementation.

**Configuration:** `approvals_reviewer = "auto_review"` in `config.toml`

**Model:** `codex-auto-review1` — purpose-built specialized model, not a general-purpose model.

**What gets routed (only boundary-crossing actions):**
- Shell/exec calls requesting elevated sandbox permissions
- Network requests blocked by policy
- File edits outside allowed writable directories
- MCP/app tool calls marked for approval
- Browser access to new domains

**Risk classification (four blocked categories):**
- Data exfiltration / secret transmission to untrusted locations
- Security setting degradation
- Destructive irreversible actions
- Untrusted code execution / prompt injection following

**Performance (10,000 actions):**
- ~9,280 (92.8%): sandbox-contained, no review needed
- ~720 (7.2%): routed to auto-review
  - ~713 auto-approved (99.1%)
  - ~7 denied
    - ~4 handled by agent via safer alternative
    - ~3 escalated to human
- Net: 99.93% of all actions approved without human interrupt
- Prompt injection recall: 99.3%
- Human interrupts reduced ~200x vs manual approval mode

**Circuit breaker:** 3 consecutive or 10 rolling denials within 50 reviews → escalate to user

**Key principle:** Auto-review changes *who* evaluates boundary-crossing requests, not *which* actions require review. It doesn't expand writable_roots or weaken protected paths.

### Non-interactive / Exec Mode

`codex exec` (alias `codex e`) runs fully non-interactively:
- `--json`: Outputs newline-delimited JSON events
- `--ephemeral`: No session persistence
- `--output-last-message, -o`: Writes final message to file
- `codex exec resume --last`: Resumes last session

---

## 3. GitHub Copilot CLI

### Four Agent Modes (cycled via Shift+Tab)

| Mode | Behavior |
|------|----------|
| Interactive (default) | Explicit approval per tool call |
| Autopilot | Autonomous, no per-tool approval; session-level grant |
| Plan | Creates implementation plan for user review before executing |
| Fleet | Parallel subagent orchestration with per-subagent or batch approval |

### Autopilot UX Flow

1. Shift+Tab to reach autopilot, or launch with `copilot --autopilot`
2. Permission dialog (3 options):
   - Enable all permissions → `--allow-all` equivalent
   - Continue with limited permissions → auto-skips operations needing individual approval
   - Cancel
3. VS Code defaults to full permissions automatically (skips dialog)
4. Agent executes continuously: `"Continuing autonomously (X premium requests)"`

**Programmatic control:** `copilot --autopilot --allow-all --max-autopilot-continues 10`

### Loop Termination Conditions

Autopilot stops in exactly four conditions:
1. AI determines task is complete
2. Blocking problem (missing credentials, env not set up)
3. User interrupts with Ctrl+C
4. `--max-autopilot-continues` limit reached

### Cost Visibility (unique feature)

Each autonomous continuation displays premium request cost in real time before execution. With `--max-autopilot-continues 10` and Claude Opus 4.6 (3x multiplier), max cost = 33 premium requests. Internal tool calls not billed — only model inference steps.

### Subagent Architecture

Specialized subagents: `Explore` (read-only), `Task` (commands), `Code Review`, `Plan`. Fleet mode: coordinator decomposes tasks for parallel execution.

---

## 4. Cross-Tool Best Practices

### Pattern 1: Four-Tier Risk Classification

| Tier | Category | Examples | Governance |
|------|----------|----------|------------|
| 1 | Read-only | File reads, GET requests, `ls`, `find` | Full autonomy, log only |
| 2 | Reversible local | File edits in working dir, `mkdir`, draft creation | Auto-approve, audit trail |
| 3 | External/boundary-crossing | Network POST, push to remote, MCP calls | Route to reviewer (human or LLM) |
| 4 | Irreversible/destructive | `rm -rf`, force push, IAM changes, prod deploy | Hard block or mandatory human |

**Side-effect trap:** "Read-only" ops can have side effects (marking emails read, incrementing counters) — always check.

### Pattern 2: Secondary LLM as Risk Judge

Classifier input: user messages + tool calls (NOT agent reasoning, NOT tool outputs)  
This prevents prompt injection from influencing the judge.

- **Fail-closed on errors** — timeouts and parse failures deny the action, not allow it
- **Rejection rationale returned to agent** — enables self-correction without human involvement
- **Circuit breakers** — 3 consecutive or 10-20 total denials escalate to human

### Pattern 3: External Loop Control

Four mechanisms (all external to the model — models cannot detect their own loops):

1. **Hard step limit** — configurable max LLM calls per session
2. **Repetition detection** — track identical tool calls with identical args; 3 identical calls → StuckLoopError
3. **A-B alternation detection** — detect two-tool cycles (A→B→A→B indefinitely)
4. **Wall-clock timeout** — hard time limit independent of call count

**Cardinal rule:** Loop detection runs *outside* the model. Each repeated call appears locally justified within the agent's context.

### Pattern 4: Rollback and State Safety

| Mechanism | Used by | How it works |
|-----------|---------|--------------|
| Sandbox isolation (OS-level) | Codex | Restricts paths/network at OS level |
| Protected path list | Claude Code, Codex | Never auto-approve writes to `.git`, `.gitconfig`, etc. |
| Transactional snapshots | Research | ACID snapshot before action → rollback on failure |
| Worktree isolation | Multi-agent patterns | Each agent gets own branch/worktree |
| `rm -rf /` circuit breaker | Claude Code | Hard prompt even in bypass mode |

### Pattern 5: User Interruption

- **Ctrl+C** — immediate halt (SIGINT)
- **Shift+Tab mid-session** — mode switch to reduce autonomy (Copilot CLI, Claude Code)
- **`/permissions` command** — in-session mode switching (Codex, Claude Code)
- **Cost display before execution** — Copilot CLI shows premium requests before each continuation
- **`/approve` command** — one-shot override of last denial (Codex)

### Pattern 6: Trust Boundary (Scope Pinning)

The trust boundary = the set of resources the agent can autonomously act on.

- Claude Code: default = current git repo + configured remotes
- Codex: default = `workspace_write` sandbox root (CWD). Configurable `writable_roots`
- Copilot CLI: full permissions granted at session start, or limited (auto-skip boundary-crossing)

**Principle:** *The trust boundary should be the smallest set that lets the task complete.*

### Threat Model (from Claude Code)

Four root causes that auto mode defends against:
1. **Overeager behavior** — agent exceeds what user authorized
2. **Honest mistakes** — agent misunderstands scope or task
3. **Prompt injection** — malicious content in tool outputs hijacks behavior
4. **Model misalignment** — model pursues subtly wrong objective

**Key insight:** The same defense mechanism (block + require safer alternative) works against all four. You don't need to distinguish between root causes at runtime.

---

## Comparison Matrix

| Dimension | Claude Code auto | Codex auto_review | Copilot CLI autopilot |
|-----------|-----------------|-------------------|----------------------|
| Secondary LLM judge | Yes (Sonnet 4.6) | Yes (codex-auto-review1) | No |
| Classifier input | User msgs + tool calls (strips outputs) | Full context | N/A |
| Prompt injection defense | Input probe + output classifier | 99.3% recall | Not documented |
| Circuit breaker | 3 consec / 20 total | 3 consec / 10 rolling of 50 | max-autopilot-continues |
| OS sandboxing | Dev container / external | Native seatbelt/bwrap/seccomp | Not documented |
| Denial recovery | Agent self-corrects | Agent self-corrects (>50%) | Op skipped (limited mode) |
| Cost visibility | Not prominent | Not prominent | Real-time per-continuation |
| YOLO flag | `--dangerously-skip-permissions` | `--yolo` | `--allow-all` |
