import { appendFileSync, readFileSync } from 'node:fs'
import type { HookInput } from '../guard.ts'

// Only node: built-ins are imported statically. The guard and policy modules are loaded
// inside the try block so that any load-time failure exits 2 (blocking) instead of 1.

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`missing env ${name}`)
  return value
}

try {
  const { decide, realpathLoose } = await import('../guard.ts')
  const { loadPolicy } = await import('../policy.ts')
  const workDir = requireEnv('TEST_AGENT_WORK_DIR')
  const runDir = requireEnv('TEST_AGENT_RUN_DIR')
  const logFile = requireEnv('TEST_AGENT_GUARD_LOG')
  const input = JSON.parse(readFileSync(0, 'utf8')) as HookInput
  if (
    input === null ||
    typeof input !== 'object' ||
    typeof input.tool_name !== 'string'
  ) {
    throw new Error('invalid hook input')
  }
  const decision = decide(input, {
    policy: loadPolicy(),
    workDir,
    runDir,
    realpath: realpathLoose,
  })
  appendFileSync(
    logFile,
    `${JSON.stringify({ tool_use_id: input.tool_use_id, tool_name: input.tool_name, ...decision })}\n`,
  )
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.allow ? 'allow' : 'deny',
        permissionDecisionReason: decision.reason,
      },
    }),
  )
} catch (error) {
  process.stderr.write(
    `guard failure: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(2)
}
