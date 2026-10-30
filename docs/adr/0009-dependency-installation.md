# ADR 0009: Installing dependencies from an untrusted pull request

Status: Accepted

## Context

`npm ci` needs network access to fetch packages, and the pull request may change `package.json` or a lockfile to pull in a malicious dependency. npm lifecycle scripts run arbitrary code at install time. The backend relies on a `postinstall` script for `prisma generate`.

## Options

1. Install without network from a cache built on the base branch.
2. Skip the agent whenever dependencies change.
3. Install with network but without lifecycle scripts and without secrets, under an egress allowlist, and flag dependency changes in the report.

## Decision

Option 3:

- `npm ci --ignore-scripts` for the analysed tree runs inside the pinned runner container, in a step that has no secrets. It does not run on the runner host, because npm still reads the pull request's own `.npmrc` (for example `git=./script`) when scripts are ignored, and a process left behind on the host could later reach secrets or rewrite trusted files. The trusted tooling is installed on the host, from the base checkout only.
- `prisma generate` runs explicitly as a separate step, also without secrets, because `postinstall` is skipped. It runs inside a throwaway container, not on the runner host. It executes pull request code (the `prisma` package from the head lockfile and `backend/prisma.config.ts`), and a process left behind on the host could later read the agent's environment or alter trusted scripts. Changes to `schema.prisma` or `prisma.config.ts` are normal feature work and do not stop the agent.
- The model API key is introduced only in the agent step, which comes after installation.
- Job egress is restricted to the npm registry and the model API, so anything that slips through has nowhere to send data.
- If the pull request changes `package.json` or a lockfile, the agent still runs, and the comment states clearly that dependencies changed.

Dependency scanning is a production extension.

## Why

- Ignoring scripts removes the most common install-time attack vector without losing a working install.
- Running the install before any secret exists means there is nothing to steal at that point; the egress allowlist covers what runs later.
- Skipping the agent on dependency changes would make it useless for many real feature pull requests.
