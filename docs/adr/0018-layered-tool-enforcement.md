# ADR 0018: Layered enforcement of what the agent may do

Status: Accepted

## Context

The agent may only write test files and run one test runner (ADR 0008, ADR 0010). The final verifier rejects any patch that breaks this, but a run should be stopped early, and the agent must never read secrets or reach the network along the way.

## Options

1. Rely on the final verifier only.
2. Rely on the prompt and the agent's tool list.
3. Several independent layers, from loosest to strictest, each enough to stop most violations on its own.

## Decision

Option 3, layers from loosest to strictest:

1. **Agent frontmatter tool allowlist:** `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Skill`, `Bash`. No `WebFetch`, no `WebSearch`, no MCP tools. Claude Code runs with `--strict-mcp-config`.
2. **Settings from base passed explicitly** with `--settings`, and permission mode `dontAsk`, so anything not allowed is denied rather than prompted. `Bash` is allowed only for our runner. The Bash sandbox has no network.
3. **`PreToolUse` hook on every tool** (matcher `*`), fail-closed. It reads the same policy file as the verifier, so the two cannot drift. It blocks writes outside test globs, any Bash other than the runner, and reads of `.env` or other secret-bearing files.
4. **The verifier** checks the final patch regardless (ADR 0008, ADR 0012). Even if every layer above fails, nothing unverified reaches the branch.

To verify during implementation:

- In CI, project-level `allow` rules may not apply without workspace trust, so the design relies on the explicit `--settings` file and the hook.
- Some read-only tools may be allowed even under `dontAsk`, which is why the hook matches every tool.
- The transcript is checked to confirm the hook actually ran for every tool call; this is asserted, not assumed.
- The guard has its own tests.
- The Claude Code Bash sandbox relies on bubblewrap, which usually cannot create user namespaces on `ubuntu-24.04` runners because of AppArmor. If it is unavailable, layer 2 consists of the permission rules only, and the network barrier for executed code is the runner's container with `--network none` (ADR 0010).

## Why

- Each layer covers a different failure: misconfigured settings, a permissive default, or a bypass of the hook.
- One shared policy file for the hook and the verifier keeps the early and late checks consistent.
- The verifier as the last line means the security of the result does not depend on Claude Code configuration being perfect.
