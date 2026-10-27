import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type ChildProcess,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { readdir, readFile } from 'node:fs/promises'
import { RotatingLog, type RotatingLogOptions } from './rotating-log.js'
import { resolveSpawnCommand } from './spawn-command.js'

const PROCESS_GROUP_POLL_INTERVAL_MS = 25

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
    return this.child?.exitCode === null && this.child.signalCode === null ? this.child : null
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
      controller.abort()
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
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') return terminateWindowsProcessTree(child, timeoutMs)
  const processGroupId = child.pid
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

async function terminateWindowsProcessTree(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<void> {
  if (!child.pid) throw new Error('Cannot stop a Windows runtime without its PID')
  await new Promise<void>((resolve, reject) => {
    let killer: ChildProcess | undefined
    let settled = false
    let leaderExited = child.exitCode !== null || child.signalCode !== null
    let treeStopped = false
    let stderr = ''
    const cleanup = () => {
      clearTimeout(timer)
      child.off('exit', onLeaderExit)
      child.off('error', fail)
      killer?.off('exit', onTaskkillExit)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      // A failed tree stop blocks installation; killing taskkill cannot confirm runtime exit.
      if (killer?.exitCode === null && killer.signalCode === null) killer.kill()
      reject(error)
    }
    const finish = () => {
      if (settled || !leaderExited || !treeStopped) return
      settled = true
      cleanup()
      resolve()
    }
    const onLeaderExit = () => {
      leaderExited = true
      finish()
    }
    const onTaskkillExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== 0) {
        fail(
          new Error(
            `taskkill failed for runtime ${child.pid} (code=${code}, signal=${signal}): ${stderr.trim()}`
          )
        )
        return
      }
      treeStopped = true
      finish()
    }
    const timer = setTimeout(
      () => fail(new Error(`Timed out waiting for Windows process tree ${child.pid} to exit`)),
      timeoutMs
    )
    child.once('exit', onLeaderExit)
    child.once('error', fail)
    try {
      // Console runtimes require forced tree termination; await taskkill as well as the leader.
      killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      killer.stderr?.setEncoding('utf8')
      killer.stderr?.on('data', chunk => {
        stderr = `${stderr}${String(chunk)}`.slice(-16_384)
      })
      killer.once('exit', onTaskkillExit)
      // Retain this listener through kill cleanup so a late spawn/kill error is handled.
      killer.on('error', fail)
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let firstDeadAt: number | null = null
  while (true) {
    const state = await inspectProcessGroup(processGroupId)
    const now = Date.now()
    if (state === 'absent') return true
    if (state === 'dead') {
      // A second scan can find children forked after the previous /proc listing.
      if (firstDeadAt !== null && now - firstDeadAt >= PROCESS_GROUP_POLL_INTERVAL_MS) {
        return true
      }
      firstDeadAt ??= now
    } else {
      firstDeadAt = null
    }
    if (now >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, PROCESS_GROUP_POLL_INTERVAL_MS))
  }
}

async function inspectProcessGroup(processGroupId: number): Promise<'absent' | 'dead' | 'present'> {
  try {
    process.kill(-processGroupId, 0)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return 'absent'
    if (code === 'EPERM') return 'present'
    throw error
  }
  if (process.platform !== 'linux') return 'present'

  // Container PID 1 may leave exited descendants unreaped. kill(-pgid, 0)
  // still sees their group, but zombies cannot run or respond to SIGKILL.
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    let value: string
    try {
      value = await readFile(`/proc/${pid}/stat`, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ESRCH') continue
      throw error
    }
    // comm is parenthesized and may itself contain spaces or parentheses.
    const endOfName = value.lastIndexOf(')')
    const [state, , group] = value
      .slice(endOfName + 2)
      .trim()
      .split(/\s+/)
    if (endOfName < 0 || !state || !group || !Number.isSafeInteger(Number(group))) {
      throw new Error(`Invalid process stat for PID ${pid}`)
    }
    if (Number(group) === processGroupId && !['Z', 'X', 'x'].includes(state)) {
      return 'present'
    }
  }
  return 'dead'
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
