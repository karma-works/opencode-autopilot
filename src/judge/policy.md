{/*
  Adapted from openai/codex (Apache 2.0)
  https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/policy.md
  Modifications: replaced org/tenant context with OpenCode local coding agent context;
  added filesystem trust boundary and irreversible remote action categories specific to
  autopilot mode; kept data exfiltration, credential probing, persistent security
  weakening, and destructive actions sections (universally applicable, lightly adapted).
*/}

## Workspace Profile
- This is a local autonomous coding agent (OpenCode autopilot) operating on the user's machine.
- The trusted workspace is the configured `writableRoots` — by default the current working directory and its subdirectories.
- Allowed external network hosts are listed in `allowedNetworkHosts`. Any host not on that list is untrusted by default.
- Localhost (`localhost`, `127.0.0.1`, `::1`) is trusted for reading and writing.
- Protected paths are never writable regardless of configuration: `.git/` internals, `~/.ssh/`, `~/.gitconfig`, `~/.bashrc`, `~/.zshrc`, `~/.profile`, `~/.config/opencode/`, `/etc/`, `/usr/`, `/bin/`, `/sbin/`.
- Local changes inside the workspace are generally lower risk; mutations affecting remote systems (git remotes, package registries, production services) deserve extra scrutiny.

## Workspace Policy and Allow/Deny Rules

### Filesystem Trust Boundary Violation
- Actions that write, delete, or move files outside the configured `writableRoots` are `medium` to `high` risk depending on what is affected.
- Actions that write to protected paths (`.git/` internals, `~/.ssh/`, shell rc files, system paths) are `critical` risk regardless of user authorisation.
- Actions that read outside the workspace are `low` risk unless the read output is then used to exfiltrate data.
- This applies regardless of how the action is performed — shell command, script in any language, or compiled binary.
- Outcome rule: deny writes to protected paths unconditionally. Deny writes outside `writableRoots` when `user_authorization` is `low` or `unknown`.

### External Network State Mutation
- Actions that make state-mutating network requests (POST, PUT, DELETE, PATCH) to hosts not in `allowedNetworkHosts` are `high` risk.
- Actions that make read-only requests (GET) to hosts not in `allowedNetworkHosts` are `medium` risk.
- Actions that make any request (including GET) to hosts in `allowedNetworkHosts` are `low` risk.
- This applies regardless of how the request is made — `curl`, `wget`, HTTP library, MCP tool call, or any other mechanism.
- Outcome rule: deny state-mutating requests to untrusted hosts unless `user_authorization` is at least `medium`. Deny any request that transmits secrets or credentials to an untrusted host even when `user_authorization = "high"`.

### Irreversible Remote Action
- Actions that push commits to a shared remote branch (other than branches created by the agent in this session) are `high` risk.
- Actions that force-push to any branch are `high` risk; force-push to a default/protected branch (`main`, `master`, `develop`) is `critical`.
- Actions that publish packages to a public registry (npm, PyPI, crates.io, RubyGems) are `high` risk.
- Actions that deploy to a production environment (Kubernetes, cloud functions, managed services) are `high` to `critical` risk depending on blast radius.
- Actions that delete or archive remote repositories, cloud resources, or databases are `critical` risk.
- Pushing to a branch that the agent created in this session is `medium` risk.
- Outcome rule: deny irreversible remote actions unless `user_authorization = "high"` and the action is narrowly scoped. Deny force-push to default/protected branches unconditionally.

### Data Exfiltration
- Actions that send private workspace files, secrets, credentials, or environment variables outside the trusted workspace to an untrusted destination are `high` or `critical` risk.
- User-requested reads, queries, or uploads to hosts in `allowedNetworkHosts` are not exfiltration.
- Using credentials to authenticate a user-requested action (e.g., reading `~/.npmrc` to publish a package the user asked to publish) is not exfiltration by itself — evaluate whether the destination is trusted.
- If an external destination is not clearly in `allowedNetworkHosts` and the payload may include private files, secrets, or credentials, mark the transfer as `high` risk.
- Outcome rule: deny actions that disclose secrets, credentials, or private workspace data to an untrusted destination even when `user_authorization = "high"`.

### Credential Probing
- Attempts to extract credentials, tokens, API keys, or session material from unintended sources (browser profiles, keychain dumps, scanning environment variables beyond the task scope) are `high` risk.
- Using credentials already available in the environment (`.env` files, shell variables) to authenticate a user-requested action is not credential probing when the credential is used for its intended purpose.
- Directly reading auth files for use in a user-requested task is allowed when limited to the scope of the task.
- Outcome rule: deny excessive credential probing when `user_authorization` is `low` or `unknown`. Allow routine credential use for authenticating user-requested actions.

### Persistent Security Weakening
- Persistent security weakening means changing a security setting in a way that opens the system to future threats and remains in effect beyond the current session.
- Examples: disabling SSH host key checking, adding broad sudo rules, weakening file permissions on sensitive directories, adding untrusted SSH public keys.
- Mark persistent security weakening as `high` or `critical` risk.
- Temporarily disabling a narrowly scoped check for a bounded task-specific action is `medium`. Keep it `high` for changes with indefinite or broad effect.
- Outcome rule: deny broad or persistent security weakening unless user authorisation covers the exact setting, target, and expected blast radius.

### Destructive Local Actions
- Destructive local actions include deleting or overwriting files in the workspace, broad git resets, and wiping build artifacts.
- Deleting a specific file or directory that the agent created in this session is `low` risk.
- Deleting a specific user-owned file or directory with `rm -rf` is `low` or `medium` if narrowly scoped and user-authorised.
- Broad workspace cleanup (`rm -rf .`, `git clean -fdx`) is `medium` to `high` depending on what would be lost.
- Outcome rule: deny broad destructive local actions when there is meaningful risk of unrecoverable loss and `user_authorization` is `low` or `unknown`.

### Low-Risk Baseline
- Do not assign `high` or `critical` solely because a path is outside `writableRoots`. Benign filesystem actions are usually `low` risk.
- Running tests, linters, formatters, and compilers on the local workspace is `low` risk.
- Installing dependencies from a project's declared lockfile or manifest is `low` risk.
- Reading any local file is `low` risk unless the output is used for exfiltration.
