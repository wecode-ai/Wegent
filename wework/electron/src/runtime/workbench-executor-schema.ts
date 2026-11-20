import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const PROTOCOL_VERSION = 1
const LAYOUT_VERSION = 1
const MANIFEST_VERSION = 2
let nextSchemaProbeId = 0
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

function queryExecutorSchema(command: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const startedAt = performance.now()
  return new Promise((resolve, reject) => {
    const traceEnabled = environment.WEWORK_PROCESS_TRACE === '1'
    const probeId = traceEnabled ? ++nextSchemaProbeId : null
    // A process can exit before its inherited pipes close. Log those boundaries
    // independently and record only timing and process metadata.
    const trace = (
      stage: string,
      pid?: number,
      details?: { code: number | null; signal: string | null }
    ) =>
      console.info('[executor-schema] trace', {
        probeId,
        stage,
        pid: pid ?? null,
        elapsedMs: Math.round(performance.now() - startedAt),
        ...details,
      })
    if (traceEnabled) trace('requested')
    // Never pass runtime flags or credentials into this read-only capability query.
    const child = execFile(
      command,
      ['--workbench-schema', '--version'],
      {
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
      },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      }
    )
    if (!traceEnabled) return
    const pid = child.pid

    child.once('spawn', () => trace('spawned', pid))
    child.stdout?.once('data', () => trace('stdout', pid))
    child.stderr?.once('data', () => trace('stderr', pid))
    child.once('error', () => trace('error', pid))
    child.once('exit', (code, signal) => trace('exit', pid, { code, signal }))
    child.once('close', (code, signal) => trace('close', pid, { code, signal }))
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
    response = JSON.parse(await queryExecutorSchema(command, environment))
  } catch (error) {
    throw executorSchemaQueryFailure(error, Date.now() - startedAt)
  }
  assertWorkbenchSchema(response)
}

type ExecutorCompatibilityVerifier = (environment: NodeJS.ProcessEnv) => Promise<void>

/** Reuses one successful schema probe for the selected executable during startup. */
export class ExecutorCompatibilityGate {
  private readonly pending = new Map<string, Promise<void>>()
  private readonly verified = new Set<string>()

  constructor(
    private readonly verify: ExecutorCompatibilityVerifier = assertExecutorWorkbenchCompatibility
  ) {}

  async assert(environment: NodeJS.ProcessEnv): Promise<void> {
    const key = await executorIdentity(environment)
    if (!key) return this.verify(environment)
    const existing = this.pending.get(key)
    if (existing) return existing
    if (this.verified.has(key)) {
      console.info('[executor-schema] compatibility cached')
      return
    }

    const startedAt = performance.now()
    const check = this.verify(environment)
      .then(() => {
        this.verified.add(key)
        console.info('[executor-schema] compatibility verified', {
          elapsedMs: Math.round(performance.now() - startedAt),
        })
      })
      .catch(error => {
        this.pending.delete(key)
        throw error
      })
      .finally(() => {
        this.pending.delete(key)
      })
    this.pending.set(key, check)
    return check
  }
}

async function executorIdentity(environment: NodeJS.ProcessEnv): Promise<string | null> {
  const command = environment.WEWORK_EXECUTOR_PATH?.trim()
  if (!command) return null
  const args = environment.WEWORK_EXECUTOR_ARGS_JSON || '[]'
  try {
    // Follow symbolic links so replacing the target binary invalidates the probe.
    const metadata = await stat(command, { bigint: true })
    return JSON.stringify([
      resolve(command),
      metadata.dev.toString(),
      metadata.ino.toString(),
      metadata.size.toString(),
      metadata.mtimeNs.toString(),
      args,
    ])
  } catch {
    return JSON.stringify([resolve(command), args])
  }
}
