import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const PROTOCOL_VERSION = 1
const LAYOUT_VERSION = 1
const MANIFEST_VERSION = 2
// macOS can validate a newly installed native binary before its first execution.
export const EXECUTOR_SCHEMA_QUERY_TIMEOUT_MS = 30_000

export function assertWorkbenchSchema(response: unknown): void {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Executor does not advertise Workbench layout compatibility')
  }
  const schema = response as Record<string, unknown>
  const supports = (value: unknown, required: number) =>
    Array.isArray(value) &&
    value.every(item => Number.isSafeInteger(item) && item > 0) &&
    value.includes(required)
  if (
    schema.protocol_version !== PROTOCOL_VERSION ||
    !supports(schema.workbench_layout_versions, LAYOUT_VERSION) ||
    !supports(schema.capability_manifest_versions, MANIFEST_VERSION)
  ) {
    throw new Error(
      'Executor cannot read and write Workbench layout v1 with capability manifest v2'
    )
  }
}

function executorSchemaQueryFailure(error: unknown, elapsedMs: number): Error {
  const failure = error as { code?: unknown; signal?: unknown; killed?: unknown }
  const metadata = {
    elapsedMs,
    code:
      typeof failure?.code === 'number' ||
      (typeof failure?.code === 'string' && /^[A-Z0-9_]+$/.test(failure.code))
        ? failure.code
        : null,
    signal:
      typeof failure?.signal === 'string' && /^SIG[A-Z0-9]+$/.test(failure.signal)
        ? failure.signal
        : null,
    killed: failure?.killed === true,
  }
  console.error('[executor-schema] query failed', metadata)
  // Preserve safe exit details as the cause without child output or credentials.
  return new Error('Executor Workbench schema query failed; no Home migration is permitted', {
    cause: metadata,
  })
}

export async function assertExecutorWorkbenchCompatibility(
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const command = environment.WEWORK_EXECUTOR_PATH?.trim()
  if (!command) throw new Error('Workbench requires an executor binary before Home migration')
  let configuredArgs: unknown
  try {
    configuredArgs = JSON.parse(environment.WEWORK_EXECUTOR_ARGS_JSON || '[]')
  } catch {
    throw new Error('Invalid executor arguments for Workbench schema verification')
  }
  if (!Array.isArray(configuredArgs) || configuredArgs.length !== 0) {
    throw new Error(
      'Workbench schema verification requires a direct executor binary without wrapper arguments'
    )
  }
  let response: unknown
  const startedAt = Date.now()
  try {
    // Old executors ignore unknown flags. --version makes them exit without loading Homes.
    // Never pass runtime flags or credentials into this read-only capability query.
    const { stdout } = await execute(command, ['--workbench-schema', '--version'], {
      env: {
        PATH: environment.PATH,
        SystemRoot: environment.SystemRoot,
        WINDIR: environment.WINDIR,
      },
      timeout: EXECUTOR_SCHEMA_QUERY_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    })
    response = JSON.parse(stdout)
  } catch (error) {
    throw executorSchemaQueryFailure(error, Date.now() - startedAt)
  }
  assertWorkbenchSchema(response)
}
