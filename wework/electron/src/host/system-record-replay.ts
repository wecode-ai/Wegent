import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

export type SystemRecordingStepType = 'mouse' | 'key' | 'scroll'

export interface SystemRecordingStep {
  id: string
  type: SystemRecordingStepType
  offsetMs: number
  appName: string
  appBundleId: string
  windowTitle: string
  targetRole: string
  targetSubrole: string
  targetTitle: string
  risk: 'low' | 'high'
  replayable: boolean
  reason?: string
  x?: number
  y?: number
  button?: 'left' | 'right' | 'other'
  clickCount?: number
  keyCode?: number
  modifiers?: number
  deltaX?: number
  deltaY?: number
}

export interface SystemRecording {
  id: string
  title: string
  createdAt: number
  endedAt: number
  steps: SystemRecordingStep[]
}

export interface SystemRecordingSummary {
  id: string
  title: string
  createdAt: number
  endedAt: number
  stepCount: number
  durationMs: number
  applicationCount: number
  containsHandoff: boolean
}

export interface SystemRecordReplayStatus {
  supported: boolean
  accessibilityGranted: boolean
  inputMonitoringGranted: boolean
  phase: 'idle' | 'recording' | 'replaying' | 'paused' | 'failed'
  recordingId: string | null
  title: string | null
  stepCount: number
  currentStep: number | null
  currentApplication: string | null
  message: string | null
}

interface ActiveRecording {
  id: string
  title: string
  startedAt: number
  steps: SystemRecordingStep[]
  child: ChildProcessWithoutNullStreams
}

interface RecordingFile {
  version: 1
  recordings: SystemRecording[]
}

interface HelperStatus {
  supported?: boolean
  accessibilityGranted?: boolean
  inputMonitoringGranted?: boolean
  error?: string
}

interface SystemRecordReplayOptions {
  readyTimeoutMs?: number
  operationTimeoutMs?: number
  exitTimeoutMs?: number
}

const MAX_RECORDINGS = 100
const MAX_REPLAY_DELAY_MS = 1_500
const HELPER_READY_TIMEOUT_MS = 5_000
const HELPER_OPERATION_TIMEOUT_MS = 15_000
const HELPER_EXIT_TIMEOUT_MS = 2_000

export class SystemRecordReplay {
  private readonly storagePath: string
  private readonly readyTimeoutMs: number
  private readonly operationTimeoutMs: number
  private readonly exitTimeoutMs: number
  private readonly helperChildren = new Set<ChildProcessWithoutNullStreams>()
  private activeRecording: ActiveRecording | null = null
  private replayChild: ChildProcessWithoutNullStreams | null = null
  private replayCancelled = false
  private statusValue: SystemRecordReplayStatus = idleStatus(process.platform === 'darwin')

  constructor(
    dataDirectory: string,
    private readonly helperPath: string,
    private readonly platform: NodeJS.Platform = process.platform,
    options: SystemRecordReplayOptions = {}
  ) {
    this.storagePath = join(dataDirectory, 'system-recordings', 'recordings.json')
    this.readyTimeoutMs = options.readyTimeoutMs ?? HELPER_READY_TIMEOUT_MS
    this.operationTimeoutMs = options.operationTimeoutMs ?? HELPER_OPERATION_TIMEOUT_MS
    this.exitTimeoutMs = options.exitTimeoutMs ?? HELPER_EXIT_TIMEOUT_MS
  }

  async status(): Promise<SystemRecordReplayStatus> {
    if (this.statusValue.phase !== 'idle') return { ...this.statusValue }
    const permissions = await this.helperStatus()
    this.statusValue = { ...this.statusValue, ...permissions }
    return { ...this.statusValue }
  }

  async requestPermissions(): Promise<SystemRecordReplayStatus> {
    this.assertSupported()
    await this.runHelper('request-permissions')
    return this.status()
  }

  async list(): Promise<SystemRecordingSummary[]> {
    const file = await this.readFile()
    return file.recordings
      .map(recording => ({
        id: recording.id,
        title: recording.title,
        createdAt: recording.createdAt,
        endedAt: recording.endedAt,
        stepCount: recording.steps.length,
        durationMs: Math.max(0, recording.endedAt - recording.createdAt),
        applicationCount: new Set(recording.steps.map(step => step.appBundleId).filter(Boolean))
          .size,
        containsHandoff: recording.steps.some(step => !step.replayable),
      }))
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  async start(title: string): Promise<SystemRecordReplayStatus> {
    if (this.activeRecording || isActivePhase(this.statusValue.phase)) {
      throw new Error('System record and replay is already active')
    }
    const permissions = await this.helperStatus()
    if (!permissions.supported) throw new Error('System recording is currently supported on macOS')
    if (!permissions.accessibilityGranted || !permissions.inputMonitoringGranted) {
      throw new Error('Enable Accessibility and Input Monitoring permissions before recording')
    }

    const child = this.spawnHelper('record')
    const active: ActiveRecording = {
      id: randomUUID(),
      title: title.trim() || 'Untitled system recording',
      startedAt: Date.now(),
      steps: [],
      child,
    }
    this.activeRecording = active
    this.statusValue = {
      ...permissions,
      phase: 'recording',
      recordingId: active.id,
      title: active.title,
      stepCount: 0,
      currentStep: null,
      currentApplication: null,
      message: 'Recording mouse, keyboard, scrolling, and application context',
    }
    await this.consumeRecordingOutput(active)
    return { ...this.statusValue }
  }

  async stop(): Promise<SystemRecording> {
    const active = this.activeRecording
    if (!active) throw new Error('No system recording is active')
    this.activeRecording = null
    active.child.kill('SIGTERM')
    await waitForExit(active.child, this.exitTimeoutMs)
    const endedAt = Date.now()
    const recording: SystemRecording = {
      id: active.id,
      title: active.title,
      createdAt: active.startedAt,
      endedAt,
      steps: active.steps,
    }
    await this.mutate(recordings => [
      recording,
      ...recordings.filter(item => item.id !== recording.id),
    ])
    this.statusValue = idleStatus(this.platform === 'darwin')
    return recording
  }

  async remove(id: string): Promise<boolean> {
    let removed = false
    await this.mutate(recordings =>
      recordings.filter(recording => {
        if (recording.id !== id) return true
        removed = true
        return false
      })
    )
    return removed
  }

  async replay(id: string): Promise<SystemRecordReplayStatus> {
    if (this.activeRecording || isActivePhase(this.statusValue.phase)) {
      throw new Error('System record and replay is already active')
    }
    const recording = (await this.readFile()).recordings.find(item => item.id === id)
    if (!recording) throw new Error('System recording not found')
    const permissions = await this.helperStatus()
    if (!permissions.accessibilityGranted) {
      throw new Error('Enable Accessibility permission before replaying')
    }
    this.replayCancelled = false
    this.statusValue = {
      ...permissions,
      phase: 'replaying',
      recordingId: id,
      title: recording.title,
      stepCount: recording.steps.length,
      currentStep: 0,
      currentApplication: null,
      message: null,
    }
    void this.runReplay(recording)
    return { ...this.statusValue }
  }

  cancel(): void {
    this.replayCancelled = true
    this.replayChild?.kill('SIGKILL')
    if (
      this.statusValue.phase === 'replaying' ||
      this.statusValue.phase === 'paused' ||
      this.statusValue.phase === 'failed'
    ) {
      this.statusValue = idleStatus(this.platform === 'darwin')
    }
  }

  async dispose(): Promise<void> {
    this.replayCancelled = true
    const children = [...this.helperChildren]
    for (const child of children) child.kill('SIGTERM')
    await Promise.all(children.map(child => waitForExit(child, this.exitTimeoutMs)))
    this.activeRecording = null
    this.statusValue = idleStatus(this.platform === 'darwin')
  }

  private consumeRecordingOutput(active: ActiveRecording): Promise<void> {
    return new Promise((resolveReady, rejectReady) => {
      let ready = false
      const timeout = setTimeout(() => {
        reportFailure('System recording helper did not become ready')
      }, this.readyTimeoutMs)
      const settleReady = () => {
        if (ready) return
        ready = true
        clearTimeout(timeout)
        resolveReady()
      }
      const reportFailure = (message: string) => {
        this.fail(message)
        if (ready) return
        ready = true
        clearTimeout(timeout)
        rejectReady(new Error(message))
      }

      const lines = createInterface({ input: active.child.stdout })
      lines.on('line', line => {
        if (this.activeRecording !== active) return
        const value = parseJson(line)
        if (value.error) {
          reportFailure(String(value.error))
          return
        }
        if (value.ready === true) {
          settleReady()
          return
        }
        const step = normalizeStep(value)
        if (!step) return
        active.steps.push(step)
        this.statusValue = {
          ...this.statusValue,
          stepCount: active.steps.length,
          currentApplication: step.appName || null,
          message: null,
        }
      })
      active.child.stderr.on('data', chunk => {
        const message = String(chunk).trim()
        if (!message) return
        if (!ready) {
          reportFailure(message)
          return
        }
        console.warn('[system-record-replay] recorder helper diagnostic', message)
      })
      active.child.once('error', error => reportFailure(error.message))
      active.child.once('exit', code => {
        if (this.activeRecording === active) {
          reportFailure(
            ready
              ? `System recording helper exited unexpectedly with code ${code ?? 'unknown'}`
              : `System recording helper exited before ready with code ${code ?? 'unknown'}`
          )
        }
      })
    })
  }

  private async runReplay(recording: SystemRecording): Promise<void> {
    try {
      let previousOffset = 0
      for (let index = 0; index < recording.steps.length; index += 1) {
        if (this.replayCancelled) {
          this.statusValue = idleStatus(this.platform === 'darwin')
          return
        }
        const step = recording.steps[index]
        this.statusValue = {
          ...this.statusValue,
          currentStep: index + 1,
          currentApplication: step.appName || null,
        }
        if (!step.replayable) {
          this.statusValue = {
            ...this.statusValue,
            phase: 'paused',
            message: step.reason ?? 'Replay paused before a protected system action',
          }
          return
        }
        const delay = Math.min(MAX_REPLAY_DELAY_MS, Math.max(0, step.offsetMs - previousOffset))
        previousOffset = step.offsetMs
        if (delay) await wait(delay)
        if (this.replayCancelled) return
        const result = await this.runHelper('execute', step)
        if (result.error) throw new Error(String(result.error))
      }
      this.statusValue = idleStatus(this.platform === 'darwin')
    } catch (error) {
      if (this.replayCancelled) {
        this.statusValue = idleStatus(this.platform === 'darwin')
        return
      }
      this.fail(errorMessage(error))
    }
  }

  private async helperStatus(): Promise<
    Pick<SystemRecordReplayStatus, 'supported' | 'accessibilityGranted' | 'inputMonitoringGranted'>
  > {
    if (this.platform !== 'darwin') {
      return {
        supported: false,
        accessibilityGranted: false,
        inputMonitoringGranted: false,
      }
    }
    const value = (await this.runHelper('status')) as HelperStatus
    if (value.error) throw new Error(value.error)
    return {
      supported: value.supported === true,
      accessibilityGranted: value.accessibilityGranted === true,
      inputMonitoringGranted: value.inputMonitoringGranted === true,
    }
  }

  private async runHelper(command: string, input?: unknown): Promise<Record<string, unknown>> {
    this.assertSupported()
    return new Promise((resolveRun, rejectRun) => {
      const child = this.spawnHelper(command)
      if (command === 'execute') this.replayChild = child
      let output = ''
      let errorOutput = ''
      let settled = false
      const onStdout = (chunk: Buffer) => {
        output += String(chunk)
      }
      const onStderr = (chunk: Buffer) => {
        errorOutput += String(chunk)
      }
      const cleanup = () => {
        clearTimeout(timeout)
        child.stdout.off('data', onStdout)
        child.stderr.off('data', onStderr)
        child.off('error', onError)
        child.off('exit', onExit)
        child.stdin.off('error', onStdinError)
        if (this.replayChild === child) this.replayChild = null
      }
      const reject = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        rejectRun(error)
      }
      const onError = (error: Error) => reject(error)
      const onStdinError = (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') reject(error)
      }
      const onExit = (code: number | null) => {
        if (settled) return
        settled = true
        cleanup()
        if (code !== 0 && !output.trim()) {
          rejectRun(new Error(errorOutput.trim() || `System helper exited with code ${code}`))
          return
        }
        resolveRun(parseJson(output.trim().split('\n').at(-1) ?? '{}'))
      }
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`System helper command '${command}' timed out`))
      }, this.operationTimeoutMs)
      child.stdout.on('data', onStdout)
      child.stderr.on('data', onStderr)
      child.once('error', onError)
      child.once('exit', onExit)
      child.stdin.once('error', onStdinError)
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
    })
  }

  private assertSupported(): void {
    if (this.platform !== 'darwin') {
      throw new Error(`System record and replay is not supported on ${this.platform}`)
    }
  }

  private spawnHelper(command: string): ChildProcessWithoutNullStreams {
    const child = this.helperPath.endsWith('.mjs')
      ? spawn(process.execPath, [this.helperPath, command], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      : spawn(this.helperPath, [command], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.helperChildren.add(child)
    const forget = () => this.helperChildren.delete(child)
    child.once('error', forget)
    child.once('exit', forget)
    return child
  }

  private fail(message: string): void {
    this.activeRecording?.child.kill('SIGKILL')
    this.activeRecording = null
    this.statusValue = {
      ...this.statusValue,
      phase: 'failed',
      message,
    }
  }

  private async readFile(): Promise<RecordingFile> {
    try {
      const parsed = JSON.parse(await readFile(this.storagePath, 'utf8')) as RecordingFile
      return parsed.version === 1 && Array.isArray(parsed.recordings)
        ? parsed
        : { version: 1, recordings: [] }
    } catch {
      return { version: 1, recordings: [] }
    }
  }

  private async mutate(
    update: (recordings: SystemRecording[]) => SystemRecording[]
  ): Promise<void> {
    const file = await this.readFile()
    const recordings = update(file.recordings).slice(0, MAX_RECORDINGS)
    await mkdir(dirname(this.storagePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.storagePath}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify({ version: 1, recordings }, null, 2)}\n`, {
      mode: 0o600,
    })
    await rename(temporary, this.storagePath)
  }
}

function normalizeStep(value: Record<string, unknown>): SystemRecordingStep | null {
  if (!['mouse', 'key', 'scroll'].includes(String(value.type))) return null
  return {
    id: randomUUID(),
    type: value.type as SystemRecordingStepType,
    offsetMs: numberValue(value.offsetMs),
    appName: stringValue(value.appName),
    appBundleId: stringValue(value.appBundleId),
    windowTitle: stringValue(value.windowTitle),
    targetRole: stringValue(value.targetRole),
    targetSubrole: stringValue(value.targetSubrole),
    targetTitle: stringValue(value.targetTitle),
    risk: value.risk === 'high' ? 'high' : 'low',
    replayable: value.replayable !== false,
    ...(value.reason ? { reason: String(value.reason) } : {}),
    ...(value.x !== undefined ? { x: numberValue(value.x) } : {}),
    ...(value.y !== undefined ? { y: numberValue(value.y) } : {}),
    ...(value.button === 'right' || value.button === 'other'
      ? { button: value.button }
      : value.button === 'left'
        ? { button: 'left' }
        : {}),
    ...(value.clickCount !== undefined ? { clickCount: numberValue(value.clickCount) } : {}),
    ...(value.keyCode !== undefined ? { keyCode: numberValue(value.keyCode) } : {}),
    ...(value.modifiers !== undefined ? { modifiers: numberValue(value.modifiers) } : {}),
    ...(value.deltaX !== undefined ? { deltaX: numberValue(value.deltaX) } : {}),
    ...(value.deltaY !== undefined ? { deltaY: numberValue(value.deltaY) } : {}),
  }
}

function isActivePhase(phase: SystemRecordReplayStatus['phase']): boolean {
  return phase === 'recording' || phase === 'replaying' || phase === 'paused'
}

function idleStatus(supported: boolean): SystemRecordReplayStatus {
  return {
    supported,
    accessibilityGranted: false,
    inputMonitoringGranted: false,
    phase: 'idle',
    recordingId: null,
    title: null,
    stepCount: 0,
    currentStep: null,
    currentApplication: null,
    message: null,
  }
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let forceTimer: NodeJS.Timeout | null = null
    const cleanup = () => {
      clearTimeout(timeout)
      if (forceTimer) clearTimeout(forceTimer)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const onExit = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      forceTimer = setTimeout(() => {
        cleanup()
        reject(new Error('System helper did not exit after SIGKILL'))
      }, timeoutMs)
    }, timeoutMs)
    child.once('exit', onExit)
    child.once('error', onError)
    if (child.exitCode !== null || child.signalCode !== null) onExit()
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
