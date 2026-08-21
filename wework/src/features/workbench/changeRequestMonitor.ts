import { useEffect, useSyncExternalStore } from 'react'
import {
  loadTaskChangeRequests,
  type TaskChangeRequestSnapshot,
  type TaskChangeRequestTarget,
} from '@/api/changeRequests'
import type { DeviceCommandApi } from '@/api/environment'
import type { RuntimeDeviceWorkspace, RuntimeTaskSummary } from '@/types/api'

const CACHE_KEY = 'wework:change-request-snapshots:v1'
const REFRESH_INTERVAL_MS = 30_000
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface CachedSnapshots {
  snapshots: Record<string, TaskChangeRequestSnapshot>
}

function targetKey(target: TaskChangeRequestTarget): string {
  return `${target.deviceId}\0${target.remoteUrl}\0${target.branch}`
}

function gitInfoString(task: RuntimeTaskSummary, keys: string[]): string | null {
  if (!task.gitInfo || typeof task.gitInfo !== 'object') return null
  for (const key of keys) {
    const value = task.gitInfo[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

export function runtimeTaskChangeRequestTarget(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): TaskChangeRequestTarget | null {
  const branch = gitInfoString(task, [
    'currentBranch',
    'current_branch',
    'branch',
    'branchName',
    'branch_name',
  ])
  const remoteUrl =
    workspace.repoUrl || gitInfoString(task, ['originUrl', 'origin_url', 'repoUrl', 'repo_url'])
  const workspacePath = task.workspacePath || workspace.workspacePath
  if (!branch || !remoteUrl || !workspacePath) return null
  return {
    deviceId: workspace.deviceId,
    taskId: task.taskId,
    workspacePath,
    remoteUrl,
    branch,
  }
}

function readCache(): Map<string, TaskChangeRequestSnapshot> {
  if (typeof window === 'undefined') return new Map()
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(CACHE_KEY) ?? 'null'
    ) as CachedSnapshots | null
    const now = Date.now()
    return new Map(
      Object.entries(parsed?.snapshots ?? {}).filter(([, snapshot]) => {
        const fetchedAt = Date.parse(snapshot.fetchedAt)
        return Number.isFinite(fetchedAt) && now - fetchedAt <= MAX_CACHE_AGE_MS
      })
    )
  } catch {
    return new Map()
  }
}

function writeCache(snapshots: Map<string, TaskChangeRequestSnapshot>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ snapshots: Object.fromEntries(snapshots) } satisfies CachedSnapshots)
    )
  } catch (error) {
    console.warn('[Wework change requests] Failed to persist status cache', error)
  }
}

export class ChangeRequestMonitor {
  private readonly api: DeviceCommandApi
  private readonly snapshots = readCache()
  private readonly targets = new Map<
    string,
    { target: TaskChangeRequestTarget; references: number }
  >()
  private readonly listeners = new Set<() => void>()
  private refreshPromise: Promise<void> | null = null
  private refreshTimer: number | null = null
  private refreshScheduled = false
  private visibilityListener: (() => void) | null = null

  constructor(api: DeviceCommandApi) {
    this.api = api
  }

  register(target: TaskChangeRequestTarget): () => void {
    const key = targetKey(target)
    const current = this.targets.get(key)
    this.targets.set(key, {
      target,
      references: (current?.references ?? 0) + 1,
    })
    this.startTimer()
    this.scheduleRefresh()
    return () => {
      const registered = this.targets.get(key)
      if (!registered) return
      if (registered.references > 1) {
        this.targets.set(key, { ...registered, references: registered.references - 1 })
      } else {
        this.targets.delete(key)
      }
      if (this.targets.size === 0) this.stopTimer()
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(target: TaskChangeRequestTarget): TaskChangeRequestSnapshot | null {
    return this.snapshots.get(targetKey(target)) ?? null
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise
    const targets = [...this.targets.values()].map(entry => entry.target)
    if (targets.length === 0) return
    this.refreshPromise = loadTaskChangeRequests(this.api, targets)
      .then(results => {
        let changed = false
        for (const result of results) {
          const key = targetKey(result.target)
          const previous = this.snapshots.get(key)
          if (result.error && previous) {
            this.snapshots.set(key, { ...previous, stale: true, error: result.error })
            changed = true
            continue
          }
          this.snapshots.set(key, result)
          changed = true
        }
        if (!changed) return
        writeCache(this.snapshots)
        this.listeners.forEach(listener => listener())
      })
      .finally(() => {
        this.refreshPromise = null
      })
    return this.refreshPromise
  }

  private scheduleRefresh(): void {
    if (this.refreshScheduled) return
    this.refreshScheduled = true
    queueMicrotask(() => {
      this.refreshScheduled = false
      void this.refresh()
    })
  }

  private startTimer(): void {
    if (this.refreshTimer !== null || typeof window === 'undefined') return
    this.refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void this.refresh()
    }, REFRESH_INTERVAL_MS)
    this.visibilityListener = () => {
      if (document.visibilityState === 'visible') void this.refresh()
    }
    document.addEventListener('visibilitychange', this.visibilityListener)
  }

  private stopTimer(): void {
    if (this.refreshTimer === null || typeof window === 'undefined') return
    window.clearInterval(this.refreshTimer)
    this.refreshTimer = null
    if (this.visibilityListener) {
      document.removeEventListener('visibilitychange', this.visibilityListener)
      this.visibilityListener = null
    }
  }
}

const monitors = new WeakMap<DeviceCommandApi, ChangeRequestMonitor>()

export function getChangeRequestMonitor(api: DeviceCommandApi): ChangeRequestMonitor {
  let monitor = monitors.get(api)
  if (!monitor) {
    monitor = new ChangeRequestMonitor(api)
    monitors.set(api, monitor)
  }
  return monitor
}

export function useTaskChangeRequest(
  monitor: ChangeRequestMonitor | null,
  target: TaskChangeRequestTarget | null
): TaskChangeRequestSnapshot | null {
  useEffect(() => {
    if (!monitor || !target) return
    return monitor.register(target)
  }, [monitor, target])

  return useSyncExternalStore(
    listener => monitor?.subscribe(listener) ?? (() => undefined),
    () => (monitor && target ? monitor.getSnapshot(target) : null),
    () => null
  )
}
