import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'

const MIN_RENDERER_IDLE_BUDGET_MS = 8
const MIN_USER_IDLE_MS = 1_500
const PRESSURE_RETRY_DELAY_MS = 5_000
const FALLBACK_IDLE_DELAY_MS = 250
const MAX_CPU_LOAD_RATIO = 0.75
const MIN_FREE_MEMORY_RATIO = 0.1
const MIN_SYSTEM_IDLE_SECONDS = 2

interface IdleDeadlineLike {
  timeRemaining(): number
}

export interface IdleSystemPressure {
  cpuLoadRatio: number
  freeMemoryRatio: number
  userIdleSeconds: number
}

export interface IdleTaskSchedulerHost {
  now(): number
  requestIdle(callback: (deadline: IdleDeadlineLike) => void): number
  cancelIdle(handle: number): void
  setTimer(callback: () => void, delayMs: number): number
  clearTimer(handle: number): void
  probeSystemPressure(): Promise<IdleSystemPressure>
}

export type IdleTask = () => void | Promise<void>

interface QueuedIdleTask {
  token: symbol
  run: IdleTask
}

export class IdleTaskScheduler {
  private readonly host: IdleTaskSchedulerHost
  private readonly tasks = new Map<string, QueuedIdleTask>()
  private started = false
  private running = false
  private idleHandle: number | null = null
  private timerHandle: number | null = null
  private lastUserActivityAt: number

  constructor(host: IdleTaskSchedulerHost) {
    this.host = host
    this.lastUserActivityAt = host.now()
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.scheduleDrain()
  }

  stop(): void {
    this.started = false
    this.cancelScheduledDrain()
  }

  recordUserActivity(): void {
    this.lastUserActivityAt = this.host.now()
    if (!this.running) {
      this.cancelScheduledDrain()
      this.scheduleDrain(MIN_USER_IDLE_MS)
    }
  }

  schedule(id: string, run: IdleTask): () => void {
    const normalizedId = id.trim()
    if (!normalizedId) throw new Error('Idle task id is required')
    const token = Symbol(normalizedId)
    this.tasks.set(normalizedId, { token, run })
    this.scheduleDrain()
    return () => {
      if (this.tasks.get(normalizedId)?.token === token) {
        this.tasks.delete(normalizedId)
      }
    }
  }

  pendingTaskIds(): string[] {
    return [...this.tasks.keys()]
  }

  private scheduleDrain(delayMs = 0): void {
    if (
      !this.started ||
      this.running ||
      this.tasks.size === 0 ||
      this.idleHandle !== null ||
      this.timerHandle !== null
    ) {
      return
    }
    if (delayMs > 0) {
      this.timerHandle = this.host.setTimer(() => {
        this.timerHandle = null
        this.scheduleDrain()
      }, delayMs)
      return
    }
    this.idleHandle = this.host.requestIdle(deadline => {
      this.idleHandle = null
      void this.tryRunNext(deadline)
    })
  }

  private async tryRunNext(deadline: IdleDeadlineLike): Promise<void> {
    if (!this.started || this.running || this.tasks.size === 0) return
    const userIdleMs = this.host.now() - this.lastUserActivityAt
    if (userIdleMs < MIN_USER_IDLE_MS || deadline.timeRemaining() < MIN_RENDERER_IDLE_BUDGET_MS) {
      this.scheduleDrain(Math.max(FALLBACK_IDLE_DELAY_MS, MIN_USER_IDLE_MS - userIdleMs))
      return
    }

    const activitySnapshot = this.lastUserActivityAt
    const pressure = await this.host.probeSystemPressure().catch(error => {
      console.warn('[IdleTasks] Failed to inspect system pressure', error)
      return null
    })
    if (
      !this.started ||
      this.running ||
      activitySnapshot !== this.lastUserActivityAt ||
      !pressure ||
      pressure.cpuLoadRatio > MAX_CPU_LOAD_RATIO ||
      pressure.freeMemoryRatio < MIN_FREE_MEMORY_RATIO ||
      pressure.userIdleSeconds < MIN_SYSTEM_IDLE_SECONDS
    ) {
      this.scheduleDrain(PRESSURE_RETRY_DELAY_MS)
      return
    }

    const next = this.tasks.entries().next().value as [string, QueuedIdleTask] | undefined
    if (!next) return
    const [id, task] = next
    this.tasks.delete(id)
    this.running = true
    try {
      await task.run()
    } catch (error) {
      console.error(`[IdleTasks] ${id} failed`, error)
    } finally {
      this.running = false
      this.scheduleDrain()
    }
  }

  private cancelScheduledDrain(): void {
    if (this.idleHandle !== null) {
      this.host.cancelIdle(this.idleHandle)
      this.idleHandle = null
    }
    if (this.timerHandle !== null) {
      this.host.clearTimer(this.timerHandle)
      this.timerHandle = null
    }
  }
}

function browserIdleHost(): IdleTaskSchedulerHost {
  return {
    now: () => Date.now(),
    requestIdle: callback => {
      if ('requestIdleCallback' in window) {
        return window.requestIdleCallback(callback)
      }
      return globalThis.setTimeout(
        () => callback({ timeRemaining: () => MIN_RENDERER_IDLE_BUDGET_MS }),
        FALLBACK_IDLE_DELAY_MS
      ) as unknown as number
    },
    cancelIdle: handle => {
      if ('cancelIdleCallback' in window) {
        window.cancelIdleCallback(handle)
      } else {
        globalThis.clearTimeout(handle)
      }
    },
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: handle => window.clearTimeout(handle),
    probeSystemPressure: async () => {
      if (!isElectronRuntime()) {
        return {
          cpuLoadRatio: 0,
          freeMemoryRatio: 1,
          userIdleSeconds: Number.POSITIVE_INFINITY,
        }
      }
      return invokeDesktopHost<IdleSystemPressure>('maintenance.getSystemPressure')
    },
  }
}

const idleTaskScheduler = new IdleTaskScheduler(browserIdleHost())

export function startIdleTaskScheduler(): void {
  idleTaskScheduler.start()
}

export function stopIdleTaskScheduler(): void {
  idleTaskScheduler.stop()
}

export function recordIdleTaskUserActivity(): void {
  idleTaskScheduler.recordUserActivity()
}

export function scheduleIdleTask(id: string, run: IdleTask): () => void {
  return idleTaskScheduler.schedule(id, run)
}
