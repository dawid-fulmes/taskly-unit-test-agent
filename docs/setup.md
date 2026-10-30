# Setting up the test agent on GitHub

Everything below is one-time repository configuration. Values in `code` must be used exactly as written.

## 1. GitHub App

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**.
   - Name: any, e.g. `taskly-test-agent`. The app's *slug* determines the bot login `<slug>[bot]`.
   - Homepage URL: the repository URL.
   - Webhook: **off** (uncheck *Active*).
   - Repository permissions:
     - Contents: **Read and write** (bot commit, backfill branch)
     - Checks: **Read and write** (`test-agent/verified`)
     - Pull requests: **Read and write** (sticky comment, backfill PR)
     - Issues: **Read and write** (removing the `test-agent:retry-large` label)
     - Metadata: Read (default)
   - Where can this app be installed: *Only on this account*.
2. Create the app, note the **App ID**, and generate a **private key** (`.pem`).
3. **Install** the app on this repository only.

## 2. Repository variables

**Settings → Secrets and variables → Actions → Variables**:

| Name | Value |
|---|---|
| `TEST_AGENT_APP_ID` | the App ID |
| `TEST_AGENT_BOT_LOGIN` | `<app-slug>[bot]`, e.g. `taskly-test-agent[bot]` |
| `TEST_AGENT_MODEL` | `claude-sonnet-5-5` |
| `TEST_AGENT_IMAGE` | `node:22@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd` |

No repository-level secrets are used.

## 3. Environments

**Settings → Environments**:

| Environment | Deployment branches | Required reviewers | Secrets |
|---|---|---|---|
| `test-agent-pr` | Selected branches: `main` only | none | `ANTHROPIC_API_KEY`, `TEST_AGENT_APP_PRIVATE_KEY` (the full `.pem` content) |
| `test-agent-backfill` | Selected branches: `main` only | the maintainer | `ANTHROPIC_API_KEY` |

The `main` restriction is what keeps a pull request's own workflow edits away from the secrets (ADR 0020). The publish job always uses `test-agent-pr`, so a backfill run needs exactly one approval: before the agent starts.

## 4. Labels

Create the labels `test-agent:retry-large` and `test-agent:dismiss`.

## 5. Actions settings

**Settings → Actions → General**:

- Workflow permissions: **Read repository contents and packages permissions** (the workflows request what they need per job).
- Fork pull request workflows: leave the defaults. The agent does not run for forks (ADR 0008).

## 6. Bootstrap

The privileged pipeline starts through `workflow_run`, which only fires for workflows that are already on the default branch, and the agent, skills and verifier are always taken from `main`. So:

1. Push `feat/unit-test-agent` and open a pull request into `main`. Only regular CI (`ci-backend`, `ci-frontend`, `ci-test-agent`) runs on it.
2. Merge it. The ruleset does not exist yet, or allows the admin bypass.

## 7. Ruleset on `main`

**Settings → Rules → Rulesets → New branch ruleset**, targeting the default branch:

- Require a pull request before merging, with **Require review from Code Owners**.
- Require status checks to pass:
  - `ci-backend`, `ci-frontend`, `ci-test-agent` (source: GitHub Actions)
  - `test-agent/verified`, with the source set to the **GitHub App created in step 1**, so no other actor can satisfy it.
- Bypass list: **Repository admin**. This is a single-maintainer repository, and the owner cannot approve their own pull requests (ADR 0013).
- Block force pushes.

## 8. Smoke test

Open a small pull request that changes a backend source file. Within a few minutes it should show `test-agent/verified` and a sticky comment from the bot. The workflow runs are listed under **Actions → test-agent-pr**.
