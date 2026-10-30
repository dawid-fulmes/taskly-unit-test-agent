# Claude Code CLI: verified behaviour

Checked on Claude Code 2.1.287 (macOS) during the first real agent run. These facts drive the pipeline's invocation and the transcript parsing.

| Question | Finding | Consequence |
|---|---|---|
| Named agent headless | `--agent unit-test-agent` loads `.claude/agents/unit-test-agent.md` from the working directory. | `prepare-workspace` must replace `.claude/` with the trusted copy before the run. |
| `--max-turns` | Not listed in `--help`, but accepted. | The pipeline passes it together with `--max-budget-usd` and a job timeout. |
| Budget limit result | `{"type":"result","subtype":"error_max_budget_usd","is_error":true}` | `summarizeTranscript` maps it to `max-budget` (the subtype decides; `is_error` downgrades only `success`). |
| Normal end | `subtype: "success"`, `is_error: false`, `num_turns`, `total_cost_usd` present. | Cost and turns on the PR come from this line. |
| Available tools | The session's `init` line lists only `Read`, `Edit`, `Write`, `Skill`, `Bash`. `Grep` and `Glob` are not tools in this version; a call to one gets `<tool_use_error>Error: No such tool available: …` and no hook runs. | Agent frontmatter and settings list only the five real tools. `plan.json` carries `testFiles` so the agent can find tests without a search tool, and the guard-coverage check ignores calls the harness rejected as unavailable. |
| Hook coverage | With `--include-hook-events`, every tool call has `hook_started`/`hook_response` events. The guard log had one record per `tool_use` id (15/15, including `Skill`). | The "guard ran for every call" assertion can rely on the guard log. |
| `dontAsk` + explicit `--settings` | Allowed tools ran; a disallowed `Bash` (`ls ...; grep ...`) was denied by the guard. | Matches ADR 0018 layers 2–3. |
| Bash sandbox | Not enabled: the runner needs the Docker socket, and on `ubuntu-24.04` bubblewrap is usually unavailable. | Network isolation for executed code comes from the runner container (`--network none`), per the ADR 0018 note. |
| First real run (sample `GET /api/todos/count` change) | 21 turns, $0.15, 29 s. Two new backend test files; `types.ts` skipped as excluded from coverage. | Default PR budget ($3, 60 turns) has a wide margin. |
