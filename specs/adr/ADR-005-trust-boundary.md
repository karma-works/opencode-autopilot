# ADR-005: Trust Boundary Definition

- **Status:** Accepted
- **Date:** 2026-05-25
- **Deciders:** Christian Haegele

---

## Context

The "trust boundary" defines the set of resources within which the agent can act autonomously (T1/T2) vs. actions that cross the boundary and require judge evaluation (T3) or hard-block (T4).

A trust boundary that is too wide makes autopilot dangerous. A trust boundary that is too narrow makes it useless (everything routes to the judge or gets blocked).

The trust boundary has two dimensions:
1. **Filesystem scope** — which paths can the agent write to autonomously?
2. **Network scope** — which hosts can the agent call without judge evaluation?

---

## Decision

### Filesystem Trust Boundary

**Default:** The current working directory (`process.cwd()`) and its subdirectories.

**Configuration:** `autoMode.writableRoots` — an array of absolute or relative paths. Relative paths are resolved from CWD.

```json
{
  "autoMode": {
    "writableRoots": [
      ".",
      "../shared-lib"
    ]
  }
}
```

**Protected paths (unconditional, regardless of writableRoots):**
These paths can never be autonomously written to — they are always T3 (routed to judge, and the judge will unconditionally deny them per policy.md):
- `.git/` (git internals)
- `~/.gitconfig`, `~/.gitconfig.local`
- `~/.ssh/` (SSH keys and config)
- `~/.bashrc`, `~/.zshrc`, `~/.profile`, `~/.bash_profile`
- `~/.config/opencode/` (OpenCode's own config)
- `/etc/`, `/usr/`, `/bin/`, `/sbin/`, `/lib/`
- Any path containing `/proc/`, `/sys/`, `/dev/`

This list is independent of `writableRoots`. Even if a user configures `"writableRoots": ["/"]`, protected paths remain protected.

**Readable paths:** The agent can read any path by default (subject to OS permissions). Restricting read access is a future feature.

### Network Trust Boundary

**Default:** No external network calls are auto-approved. All `webfetch` calls to external hosts and all `bash` network commands are T3 by default.

**Configuration:** `autoMode.allowedNetworkHosts` — an array of hostname patterns (exact match or glob):

```json
{
  "autoMode": {
    "allowedNetworkHosts": [
      "api.github.com",
      "registry.npmjs.org",
      "*.anthropic.com"
    ]
  }
}
```

Read-only GET requests to hosts in `allowedNetworkHosts` are classified as T1. Mutating requests (POST/PUT/DELETE) to allowed hosts are still T3 — the judge evaluates intent.

**Localhost exception:** `localhost`, `127.0.0.1`, `::1`, and any port on these addresses are T2 by default. Local dev servers, local databases, and local APIs are presumed safe for autonomous interaction.

---

## Conversational Trust Modifications

Users can narrow (not widen) the trust boundary mid-session via natural language:

- "Don't push anything" → agent interprets `git push` as T4 for the rest of the session
- "Only edit files in `src/`" → agent narrows `writableRoots` to `src/` for the session
- "Don't touch the database" → agent classifies all database-touching `bash` commands as T3+

These conversational constraints are:
- Persisted in the session's autopilot state (survives compaction)
- Visible in the TUI as "Active Constraints"
- Cannot be lifted by the agent itself (only by explicit user command)
- Not persisted beyond the session (for hard constraints, use `opencode.json`)

**Widening via conversation is not supported.** The agent cannot convince itself to expand the trust boundary beyond what's configured.

---

## Scope Pinning Principle

From cross-tool research: *"The trust boundary should be the smallest set that lets the task complete."*

This principle is operationalized as a startup hint: when autopilot mode is first activated, OpenCode analyzes the user's stated task and suggests a minimum trust boundary:

```
Autopilot mode: For this task, the minimum trust boundary is:
  Filesystem: ./src, ./tests
  Network: api.github.com (for PR creation)
  
Expand? [y/N]
```

This is a suggestion, not enforcement. Users can accept, expand, or ignore it.

---

## Consequences

- `autoMode.writableRoots` defaults to `["."]` if not configured
- `autoMode.allowedNetworkHosts` defaults to `[]` if not configured
- Protected path list is hard-coded in `src/trust/protected-paths.ts` and not user-configurable
- All trust boundary decisions are logged with the reason (T1/T2/T3 classification, path match)
- CI/CD environments should configure explicit `writableRoots` and `allowedNetworkHosts` for predictable behavior
