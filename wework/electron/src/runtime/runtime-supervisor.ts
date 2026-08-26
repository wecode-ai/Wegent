import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { RotatingLog, type RotatingLogOptions } from './rotating-log.js'
import { resolveSpawnCommand } from './spawn-command.js'

export type RuntimeSupervisorState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'backoff'
  | 'failed'
  | 'stopping'
  | 'stopped'

export interface RuntimeSupervisorEvents {
  state: [RuntimeSupervisorState]
  spawn: [ChildProcessWithoutNullStreams]
  stdout: [string]
  stderr: [string]
  exit: [number | null, NodeJS.Signals | null, boolean]
  failed: [Error]
}

export interface RuntimeSupervisorOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  name: string
  log?: RotatingLogOptions
  probe?: (child: ChildProcessWithoutNullStreams, signal: AbortSignal) => Promise<void>
  startTimeoutMs?: number
  baseRestartDelayMs?: number
  maxRestartDelayMs?: number
  maxCrashes?: number
  crashWindowMs?: number
  stableAfterMs?: number
  stopTimeoutMs?: number
  extraPipeCount?: number
}

export class RuntimeSupervisor extends EventEmitter<RuntimeSupervisorEvents> {
  private child: ChildProcessWithoutNullStreams | null = null
  private currentState: RuntimeSupervisorState = 'idle'
  private startPromise: Promise<ChildProcessWithoutNullStreams> | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private crashes: number[] = []
  private consecutiveCrashes = 0
  private stopping = false
  private readonly log: RotatingLog | null

  constructor(private readonly options: RuntimeSupervisorOptions) {
    super()
    this.log = options.log ? new RotatingLog(options.log) : null
  }

  state(): RuntimeSupervisorState {
    return this.currentState
  }

  current(): ChildProcessWithoutNullStreams | null {
    return this.child?.exitCode === null ? this.child : null
  }

  pid(): number | null {
    return this.current()?.pid ?? null
  }

  start(): Promise<ChildProcessWithoutNullStreams> {
    const running = this.current()
    if (running && this.currentState === 'ready') return Promise.resolve(running)
    this.stopping = false
    this.startPromise ??= this.spawnAndProbe().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearTimers()
    this.setState('stopping')
    const child = this.current()
    if (child) await terminateProcessTree(child, this.options.stopTimeoutMs ?? 5_000)
    this.child = null
    this.setState('stopped')
    await this.log?.flush()
  }

  private async spawnAndProbe(): Promise<ChildProcessWithoutNullStreams> {
    this.setState('starting')
    const stdio: Array<'pipe'> = ['pipe', 'pipe', 'pipe']
    for (let index = 0; index < (this.options.extraPipeCount ?? 0); index += 1) {
      stdio.push('pipe')
    }
    const resolved = resolveSpawnCommand(this.options.command, this.options.args ?? [])
    const child = spawn(resolved.command, resolved.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      detached: process.platform !== 'win32',
      stdio,
      windowsHide: true,
    } satisfies SpawnOptionsWithoutStdio) as ChildProcessWithoutNullStreams
    const spawned = waitForSpawn(child)
    this.child = child
    this.attach(child)
    this.emit('spawn', child)
    void this.writeLog('supervisor', `spawned pid=${child.pid ?? 'unknown'}`)

    try {
      await spawned
      await this.waitUntilReady(child)
    } catch (error) {
      if (this.current() === child) await terminateProcessTree(child, 1_000)
      if (!this.stopping && this.currentState !== 'backoff' && this.currentState !== 'failed') {
        this.recordCrash()
        this.restartOrFail(error instanceof Error ? error : new Error(String(error)))
      }
      throw error
    }
    if (this.current() !== child) {
      throw new Error(`${this.options.name} exited before becoming ready`)
    }
    this.setState('ready')
    this.armStableTimer(child)
    return child
  }

  private attach(child: ChildProcessWithoutNullStreams): void {
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      const value = String(chunk)
      this.emit('stdout', value)
      void this.writeLog('stdout', value)
    })
    child.stderr.on('data', chunk => {
      const value = String(chunk)
      this.emit('stderr', value)
      void this.writeLog('stderr', value)
    })
    child.once('error', error => {
      this.emit('failed', error)
      void this.writeLog('supervisor', `spawn error: ${error.message}`)
    })
    child.once('exit', (code, signal) => this.handleExit(child, code, signal))
  }

  private async waitUntilReady(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (!this.options.probe) return
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(new Error(`${this.options.name} startup timed out`)),
      this.options.startTimeoutMs ?? 30_000
    )
    timeout.unref()
    try {
      await Promise.race([
        this.options.probe(child, controller.signal),
        once(child, 'exit').then(() => {
          throw new Error(`${this.options.name} exited during startup`)
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
  }

  private handleExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.child === child) this.child = null
    this.startPromise = null
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
    const expected = this.stopping
    this.emit('exit', code, signal, expected)
    void this.writeLog(
      'supervisor',
      `exited code=${code ?? 'null'} signal=${signal ?? 'null'} expected=${expected}`
    )
    if (expected) return
    this.recordCrash()
    this.restartOrFail()
  }

  private recordCrash(): void {
    const now = Date.now()
    const windowMs = this.options.crashWindowMs ?? 60_000
    this.crashes = this.crashes.filter(timestamp => now - timestamp <= windowMs)
    this.crashes.push(now)
    this.consecutiveCrashes += 1
  }

  private scheduleRestart(): void {
    const base = this.options.baseRestartDelayMs ?? 250
    const maximum = this.options.maxRestartDelayMs ?? 10_000
    const delay = Math.min(maximum, base * 2 ** Math.max(0, this.consecutiveCrashes - 1))
    this.setState('backoff')
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping) return
      void this.start().catch(error => {
        this.emit('failed', error instanceof Error ? error : new Error(String(error)))
      })
    }, delay)
    this.restartTimer.unref()
  }

  private restartOrFail(cause?: Error): void {
    if (this.crashes.length > (this.options.maxCrashes ?? 3)) {
      const error = new Error(
        `${this.options.name} crashed ${this.crashes.length} times within ${
          this.options.crashWindowMs ?? 60_000
        }ms`,
        cause ? { cause } : undefined
      )
      this.setState('failed')
      this.emit('failed', error)
      return
    }
    this.scheduleRestart()
  }

  private armStableTimer(child: ChildProcessWithoutNullStreams): void {
    this.stableTimer = setTimeout(() => {
      if (this.current() !== child) return
      this.consecutiveCrashes = 0
      this.crashes = []
    }, this.options.stableAfterMs ?? 30_000)
    this.stableTimer.unref()
  }

  private clearTimers(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.restartTimer = null
    this.stableTimer = null
  }

  private setState(state: RuntimeSupervisorState): void {
    if (this.currentState === state) return
    this.currentState = state
    this.emit('state', state)
  }

  private writeLog(source: 'stdout' | 'stderr' | 'supervisor', value: string): Promise<void> {
    return this.log?.write(source, value) ?? Promise.resolve()
  }
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      child.off('spawn', onSpawn)
      child.off('error', onError)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

export async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<void> {
  if (child.exitCode !== null) return
  const processGroupId = process.platform === 'win32' ? null : child.pid
  const exited = once(child, 'exit').then(() => true)
  signalProcessTree(child, 'SIGTERM')
  const timer = new Promise<false>(resolve => {
    const timeout = setTimeout(() => resolve(false), timeoutMs)
    timeout.unref()
  })
  const leaderExited = await Promise.race([exited, timer])
  if (
    leaderExited &&
    (!processGroupId || (await waitForProcessGroupExit(processGroupId, Math.min(timeoutMs, 1_000))))
  ) {
    return
  }
  signalProcessTree(child, 'SIGKILL')
  if (!leaderExited) await exited
  if (processGroupId && !(await waitForProcessGroupExit(processGroupId, timeoutMs))) {
    throw new Error(`Timed out waiting for process group ${processGroupId} to exit`)
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processGroupExists(processGroupId)) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return !processGroupExists(processGroupId)
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') {
      const args = ['/pid', String(child.pid), '/t']
      if (signal === 'SIGKILL') args.push('/f')
      const killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' })
      killer.unref()
      return
    }
    if (child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
