# ADR 0012: The verifier uses head config but does not trust it

Status: Accepted

## Context

The verifier runs suites, measures coverage and typechecks using `vitest.config.ts`, `vite.config.ts` and `tsconfig.json`. These files come from the pull request head. A pull request could set `include: []`, exclude files from coverage, or loosen `tsconfig`, making a run look green with no real tests behind it.

## Options

1. Use config from the base branch.
2. Use config from the head, but derive every number independently of what that config claims.

## Decision

Option 2:

- Config is taken from the head, because pull requests can legitimately change it (for example a new path alias), and base config would break those builds.
- **Changed-lines coverage** is computed by our own script from the raw coverage JSON (the verifier adds the `json` reporter via a CLI flag), for the files in the change manifest. A file missing from the coverage report counts as 0% covered, not as skipped.
- **Coverage exclusions come from base.** The exclude list is taken from the base branch config (or a copy kept in the policy file), not from the head. A file excluded on base appears in the table as `excluded from coverage`, not 0%, and the agent marks it `skip` with that reason. A pull request that adds an exclusion changes `vitest.config.*`, so the agent does not start and a human reviews it (see below).
- **Test file discovery** uses our own glob, defined on the base branch and applied to the head. Every file it matches must actually have been run by Vitest; this catches `include` tricks without running the base suites a second time.
- **Test count baseline** is the head before the agent's patch. After the patch, the number of tests must not drop. This gate polices the agent and config tricks, not the pull request author.
- **Tests removed by the author** do not block; that is for human review. The comment states how many tests the pull request removes and in which files, computed statically from the diff against base without running suites.
- **Config changes stop the agent.** If the pull request changes `vitest.config.*`, `vite.config.*` or any `tsconfig*.json`, or its Prisma schema declares a generator other than the built-in clients (ADR 0009), the agent does not start, the check is neutral, and the comment says the config changed and a human review is required.
- These config files are covered by `CODEOWNERS`.

## Why

- Head config keeps legitimate pull requests working.
- Recomputing numbers from raw data and cross-checking file lists means a manipulated config produces a visible mismatch instead of a false green.
- A config change is rare and high-risk enough to hand to a human rather than to the agent.
