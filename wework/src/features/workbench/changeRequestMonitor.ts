import { supportsConnectionEvents } from '@/lib/device-capabilities'
import { useCallback, useSyncExternalStore } from 'react'
import {
  linkedChangeRequestTarget,
  observedChangeRequest,
  type TaskChangeRequestSnapshot,
  type TaskChangeRequestTarget,
} from '@/api/changeRequests'
import { outputAsRecord, parseGitRemote, type DeviceCommandApi } from '@/api/environment'
import type {
  RuntimeDeviceWorkspace,
  DeviceInfo,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/api'
import {
  changeRequestObservations,
  type ChangeRequestObservation,
} from './changeRequestObservations'
import {
  connectionObservationHealth,
  observationErrorCode,
  observationFailureState,
} from './resourceObservation'
import type { ChangeRequest } from '@/types/environment'
import { connectionEventSubscriptions } from '@/lib/runtime-connection-events'
import { changeRequestObserverKey, ChangeRequestUiObserver } from './changeRequestUiObserver'
import {
  findNativeLocalWorkbenchDevice,
  getUnambiguousWorkbenchDeviceAliases,
  LOCAL_WORKBENCH_DEVICE_ALIAS,
} from '@/lib/workbench-device'

const CACHE_KEY = 'wework:change-request-snapshots:v3'
const OBSERVER_LEASE_RENEWAL_MS = 30_000
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface CachedSnapshots {
  snapshots: Record<string, TaskChangeRequestSnapshot>
}

function targetKey(target: TaskChangeRequestTarget): string {
  return `${target.deviceId}\0${target.taskId}\0${target.workspacePath}\0${target.remoteUrl}\0${target.changeRequestUrl ?? target.branch}`
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

function matchesObservedBranch(
  target: TaskChangeRequestTarget,
  watch: ChangeRequestObservation
): boolean {
  const remote = parseGitRemote(target.remoteUrl)
  const linked = linkedChangeRequestTarget(watch.deviceId, watch.url)
  const observedRemote = linked && parseGitRemote(linked.remoteUrl)
  return Boolean(
    remote &&
    observedRemote &&
    remote.host === observedRemote.host &&
    remote.repoPath.toLowerCase() === observedRemote.repoPath.toLowerCase() &&
    watch.subscription.resource_states?.some(
      state =>
        state.kind === 'change_request' &&
        state.topicId === watch.url &&
        (state.provider === 'github' || state.provider === 'gitlab') &&
        observedChangeRequest(state.provider, state.data, watch.url)?.headBranch === target.branch
    )
  )
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
  private revision = 0
  private refreshPromise: Promise<void> | null = null
  private leaseRenewalTimer: number | null = null
  private refreshScheduled = false
  private targetRevision = 0
  private refreshTargetRevision = 0
  private visibilityListener: (() => void) | null = null
  private connectionObservations: ChangeRequestObservation[] = []
  private deviceAliases = new Map<string, string>()
  private eventProtocols = new Map<string, boolean>()
  private readonly uiObservers: ChangeRequestUiObserver

  constructor(api: DeviceCommandApi) {
    this.api = api
    this.uiObservers = new ChangeRequestUiObserver(api)
  }

  register(target: TaskChangeRequestTarget): () => void {
    const key = targetKey(target)
    const current = this.targets.get(key)
    this.targets.set(key, {
      target,
      references: (current?.references ?? 0) + 1,
    })
    this.synchronizeUiObservers()
    this.startLeaseRenewal()
    if (!current) {
      this.targetRevision++
      this.scheduleRefresh()
    }
    return () => {
      const registered = this.targets.get(key)
      if (!registered) return
      if (registered.references > 1) {
        this.targets.set(key, { ...registered, references: registered.references - 1 })
      } else {
        this.targets.delete(key)
      }
      this.synchronizeUiObservers()
      if (this.targets.size === 0) this.stopLeaseRenewal()
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getRevision(): number {
    return this.revision
  }

  getSnapshot(target: TaskChangeRequestTarget): TaskChangeRequestSnapshot | null {
    return this.snapshots.get(targetKey(target)) ?? null
  }

  syncConnectionObservations(
    work: RuntimeWorkListResponse | null | undefined,
    devices: DeviceInfo[] = []
  ): void {
    const aliases = getUnambiguousWorkbenchDeviceAliases(devices)
    const nativeDevices = devices.filter(device =>
      findNativeLocalWorkbenchDevice(devices, device.device_id)
    )
    if (nativeDevices.length === 1)
      aliases.set(LOCAL_WORKBENCH_DEVICE_ALIAS, nativeDevices[0].device_id)
    const protocols = new Map(
      devices.map(device => [device.device_id, supportsConnectionEvents(device)])
    )
    const protocolChanged =
      JSON.stringify([...protocols]) !== JSON.stringify([...this.eventProtocols])
    const next = structuredClone(changeRequestObservations(work))
    if (
      JSON.stringify(next) === JSON.stringify(this.connectionObservations) &&
      JSON.stringify([...aliases]) === JSON.stringify([...this.deviceAliases]) &&
      !protocolChanged
    )
      return
    const previous = this.connectionObservations
    this.connectionObservations = next
    this.deviceAliases = aliases
    this.eventProtocols = protocols
    this.synchronizeUiObservers()
    const changed = new Set<string>()
    for (const { target } of this.targets.values()) {
      const watch = this.observationFor(target)
      const prior = this.observationFor(target, previous)
      const snapshot = this.getSnapshot(target)
      const shared = this.sharedSnapshot(target)
      if (shared) {
        this.snapshots.set(targetKey(target), shared)
      } else if (watch && snapshot) {
        this.snapshots.set(targetKey(target), {
          ...snapshot,
          observation: connectionObservationHealth(watch.subscription),
          resourceEvents: this.resourceEventsFor(target, watch.url),
          stale: Boolean(watch.subscription.error_code) || snapshot.stale,
        })
      }
      if (
        (!shared &&
          watch &&
          watch.subscription.observed_events !== prior?.subscription.observed_events &&
          (watch.subscription.observed_events ?? 0) > 0) ||
        (!watch && prior) ||
        (!shared && watch && prior?.subscription.error_code && !watch.subscription.error_code)
      )
        changed.add(targetKey(target))
    }
    this.revision += 1
    this.listeners.forEach(listener => listener())
    if (changed.size || protocolChanged) void this.refresh({ changed })
  }

  private observationFor(
    target: TaskChangeRequestTarget,
    observations = this.connectionObservations
  ): ChangeRequestObservation | undefined {
    if (!this.supportsEventProtocol(target.deviceId)) return undefined
    const url = target.changeRequestUrl ?? this.getSnapshot(target)?.changeRequest?.url
    const candidates = observations.filter(
      watch =>
        this.sameDevice(watch.deviceId, target.deviceId) &&
        (url ? watch.url === url : matchesObservedBranch(target, watch)) &&
        ['preparing', 'armed', 'pending'].includes(watch.subscription.status)
    )
    const own = candidates.filter(watch => watch.taskId === target.taskId)
    const selected = own.length ? own : candidates
    if (new Set(selected.map(watch => watch.subscription.source.profile)).size !== 1)
      return undefined
    return selected.sort(
      (left, right) =>
        (right.subscription.last_collected_at ?? 0) - (left.subscription.last_collected_at ?? 0)
    )[0]
  }

  private sameDevice(left: string, right: string): boolean {
    return (this.deviceAliases.get(left) ?? left) === (this.deviceAliases.get(right) ?? right)
  }

  private resourceEventsFor(target: TaskChangeRequestTarget, url?: string) {
    const watch = this.observationFor(target)
    return watch?.taskId === target.taskId
      ? watch.subscription.resource_events?.filter(event => event.topicId === url)
      : undefined
  }

  private sharedSnapshot(target: TaskChangeRequestTarget): TaskChangeRequestSnapshot | null {
    const watch = this.observationFor(target)
    const states = watch?.subscription.resource_states
    if (!watch || !Array.isArray(states)) return null
    const provider =
      watch.subscription.source.providerId === '@wegent/dsh-connection-git/github'
        ? 'github'
        : 'gitlab'
    const state = states.find(
      state =>
        state?.kind === 'change_request' &&
        state.provider === provider &&
        state.topicId === watch.url &&
        Number.isFinite(Date.parse(state.observedAt))
    )
    if (!state) return null
    const changeRequest = observedChangeRequest(provider, state.data, watch.url)
    if (!changeRequest) return null
    return {
      target,
      changeRequest,
      provider,
      lookupState: 'found',
      fetchedAt: state.observedAt,
      stale: Boolean(watch.subscription.error_code || state.errorCode),
      error: watch.subscription.error_code ?? state.errorCode,
      observation: connectionObservationHealth(watch.subscription, state.errorCode ?? null),
      resourceEvents: this.resourceEventsFor(target, watch.url),
    }
  }

  hasHandledChange(target: TaskChangeRequestTarget, request: ChangeRequest): boolean {
    if (!request.headSha || request.checks !== 'failure') return false
    return this.connectionObservations.some(
      watch =>
        watch.taskId === target.taskId &&
        this.sameDevice(watch.deviceId, target.deviceId) &&
        watch.url === request.url &&
        ['pending', 'resuming_goal', 'delivered'].includes(watch.subscription.status) &&
        watch.subscription.handled_events?.some(
          event =>
            event.topicId === request.url &&
            event.external?.headSha === request.headSha &&
            ['change_request_state', 'checks', 'check_run', 'pipeline'].includes(
              event.external?.objectKind ?? ''
            ) &&
            ['failure', 'failed', 'cancelled', 'timed_out', 'action_required'].includes(
              event.external?.conclusion ?? event.external?.status ?? ''
            )
        ) === true
    )
  }

  private async refreshObservations(watches: ChangeRequestObservation[]): Promise<void> {
    if (!watches.length) return
    const unique = new Map(
      watches.map(watch => [
        `${this.deviceAliases.get(watch.deviceId) ?? watch.deviceId}\0${watch.subscription.observation_id ?? `${watch.taskId}/${watch.subscription.subscription_key}`}`,
        watch,
      ])
    )
    await Promise.all(
      [...unique.values()].map(async watch => {
        let error: string | null = null
        try {
          const result = await this.api.executeCommand(watch.deviceId, {
            command_key: 'connection_observation_refresh',
            args: [watch.taskId, watch.subscription.subscription_key],
          })
          const output = outputAsRecord(result.stdout)
          const subscription = connectionEventSubscriptions([output?.subscription])[0]
          if (
            !result.success ||
            !subscription ||
            subscription.subscription_key !== watch.subscription.subscription_key ||
            ['providerId', 'profile', 'kind', 'name'].some(
              field =>
                subscription.source[field as keyof typeof subscription.source] !==
                watch.subscription.source[field as keyof typeof watch.subscription.source]
            ) ||
            (watch.subscription.observation_id &&
              subscription.observation_id !== watch.subscription.observation_id)
          )
            throw new Error(result.error || 'connection_refresh_failed')
          for (const entry of this.connectionObservations) {
            if (!this.sameObservation(entry, watch)) continue
            if (
              (entry.subscription.last_collected_at ?? -1) > (subscription.last_collected_at ?? -1)
            )
              continue
            entry.subscription = {
              ...entry.subscription,
              resource_states: subscription.resource_states,
              last_collected_at: subscription.last_collected_at,
              error_code: subscription.error_code,
              refresh_pending: subscription.refresh_pending,
            }
          }
        } catch (failure) {
          error = observationErrorCode(failure)
        }
        for (const { target } of this.targets.values()) {
          const current = this.observationFor(target)
          if (!current || !this.sameObservation(current, watch)) continue
          const snapshot = this.sharedSnapshot(target) ?? this.getSnapshot(target)
          if (!snapshot) continue
          this.snapshots.set(
            targetKey(target),
            error
              ? {
                  ...snapshot,
                  stale: true,
                  error,
                  observation: {
                    state: observationFailureState(error),
                    transport: 'connection',
                    lastSuccessAt: snapshot.observation?.lastSuccessAt ?? null,
                    stale: true,
                    error,
                  },
                }
              : { ...snapshot, observation: connectionObservationHealth(current.subscription) }
          )
        }
      })
    )
    this.revision++
    writeCache(this.snapshots)
    this.listeners.forEach(listener => listener())
  }

  private sameObservation(
    left: ChangeRequestObservation,
    right: ChangeRequestObservation
  ): boolean {
    return (
      this.sameDevice(left.deviceId, right.deviceId) &&
      (left.subscription.observation_id && right.subscription.observation_id
        ? left.subscription.observation_id === right.subscription.observation_id
        : left.taskId === right.taskId &&
          left.subscription.subscription_key === right.subscription.subscription_key)
    )
  }

  private observerTarget(target: TaskChangeRequestTarget): TaskChangeRequestTarget {
    return {
      ...target,
      deviceId: this.deviceAliases.get(target.deviceId) ?? target.deviceId,
    }
  }

  private supportsEventProtocol(deviceId: string): boolean {
    return (
      this.eventProtocols.get(deviceId) ??
      this.eventProtocols.get(this.deviceAliases.get(deviceId) ?? deviceId) ??
      false
    )
  }

  private synchronizeUiObservers(): void {
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible'
    this.uiObservers.synchronize(
      visible
        ? [...this.targets.values()]
            .filter(
              ({ target }) =>
                this.supportsEventProtocol(target.deviceId) && !this.observationFor(target)
            )
            .map(({ target }) => this.observerTarget(target))
        : [],
      deviceId => this.supportsEventProtocol(deviceId)
    )
  }

  private async loadVisibleTargets(
    targets: TaskChangeRequestTarget[],
    force: boolean
  ): Promise<TaskChangeRequestSnapshot[]> {
    const grouped = new Map<string, TaskChangeRequestTarget[]>()
    for (const target of targets) {
      if (!this.supportsEventProtocol(target.deviceId)) continue
      const resolved = this.observerTarget(target)
      const key = changeRequestObserverKey(resolved)
      grouped.set(key, [...(grouped.get(key) ?? []), target])
    }
    const groups = [...grouped.values()]
    const results: TaskChangeRequestSnapshot[] = []
    for (let offset = 0; offset < groups.length; offset += 4) {
      const batch = await Promise.all(
        groups.slice(offset, offset + 4).map(async group => {
          const result = await this.uiObservers.read(this.observerTarget(group[0]), force)
          return result ? group.map(target => ({ ...result, target })) : []
        })
      )
      results.push(...batch.flat())
    }
    return results
  }

  async refresh(options: { shareInflight?: boolean; changed?: Set<string> } = {}): Promise<void> {
    if (this.refreshPromise) {
      if (options.shareInflight !== false && !options.changed?.size) return this.refreshPromise
      await this.refreshPromise
    }
    this.synchronizeUiObservers()
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    let projected = false
    for (const { target } of this.targets.values()) {
      const shared = this.sharedSnapshot(target)
      if (shared && JSON.stringify(shared) !== JSON.stringify(this.getSnapshot(target))) {
        this.snapshots.set(targetKey(target), shared)
        projected = true
      }
      const watch = this.observationFor(target)
      const knownResource =
        this.supportsEventProtocol(target.deviceId) &&
        Boolean(this.observerTarget(target).changeRequestUrl)
      if ((watch || knownResource) && !this.getSnapshot(target)) {
        this.snapshots.set(targetKey(target), {
          target,
          changeRequest: null,
          fetchedAt: new Date(0).toISOString(),
          observation: watch
            ? connectionObservationHealth(watch.subscription)
            : {
                state: 'refreshing',
                transport: 'connection',
                lastSuccessAt: null,
                stale: false,
              },
        })
        projected = true
      }
      if ((watch || knownResource) && options.shareInflight === false) {
        const current = this.getSnapshot(target)!
        this.snapshots.set(targetKey(target), {
          ...current,
          observation: {
            state: 'refreshing',
            transport: 'connection',
            lastSuccessAt: current.observation?.lastSuccessAt ?? null,
            stale: Boolean(current.stale),
          },
        })
        projected = true
      }
    }
    if (projected) {
      this.revision++
      this.listeners.forEach(listener => listener())
      writeCache(this.snapshots)
    }
    const targets = [...this.targets.values()]
      .map(entry => entry.target)
      .filter(target => !this.observationFor(target))
    const watches =
      options.shareInflight === false
        ? [...this.targets.values()]
            .map(({ target }) => this.observationFor(target))
            .filter((watch): watch is ChangeRequestObservation => Boolean(watch))
        : []
    if (targets.length === 0 && watches.length === 0) return
    this.refreshTargetRevision = this.targetRevision
    this.refreshPromise = Promise.all([
      this.refreshObservations(watches),
      this.loadVisibleTargets(targets, options.shareInflight === false),
    ])
      .then(([, results]) => {
        let changed = false
        for (const result of results) {
          const key = targetKey(result.target)
          if (!this.targets.has(key)) continue
          const shared = this.sharedSnapshot(result.target)
          if (this.observationFor(result.target)) {
            if (shared) {
              this.snapshots.set(key, shared)
              changed = true
            }
            continue
          }
          const previous = this.snapshots.get(key)
          if (!result.changeRequest && result.observation?.state === 'refreshing' && previous) {
            this.snapshots.set(key, {
              ...previous,
              observation: {
                ...result.observation,
                lastSuccessAt: previous.observation?.lastSuccessAt ?? null,
              },
            })
            changed = true
            continue
          }
          if (result.error && previous) {
            this.snapshots.set(key, {
              ...previous,
              target: result.target,
              fetchedAt: result.observation ? previous.fetchedAt : result.fetchedAt,
              provider: result.provider,
              lookupState: result.lookupState,
              stale: true,
              error: result.error,
              observation: {
                state:
                  result.lookupState === 'unauthenticated'
                    ? 'auth_required'
                    : observationFailureState(result.error),
                transport: result.observation?.transport ?? 'connection',
                lastSuccessAt: previous.observation?.lastSuccessAt ?? previous.fetchedAt,
                stale: true,
                error: result.error,
              },
            })
            changed = true
            continue
          }
          this.snapshots.set(key, {
            ...result,
            resourceEvents: this.resourceEventsFor(result.target, result.changeRequest?.url),
            observation: result.observation ?? {
              state: result.error ? observationFailureState(result.error) : 'observing',
              transport: 'connection',
              lastSuccessAt: result.error ? null : result.fetchedAt,
              stale: Boolean(result.error),
              error: result.error,
            },
          })
          changed = true
        }
        if (!changed) return
        this.revision += 1
        writeCache(this.snapshots)
        this.listeners.forEach(listener => listener())
      })
      .finally(() => {
        this.refreshPromise = null
        if (
          (typeof document === 'undefined' || document.visibilityState === 'visible') &&
          [...this.targets.values()].some(
            ({ target }) =>
              this.supportsEventProtocol(target.deviceId) &&
              this.observerTarget(target).changeRequestUrl &&
              !this.observationFor(target) &&
              !this.uiObservers.has(this.observerTarget(target))
          )
        )
          this.scheduleRefresh()
      })
    return this.refreshPromise
  }

  private scheduleRefresh(): void {
    if (this.refreshScheduled) return
    this.refreshScheduled = true
    queueMicrotask(() => {
      const refresh = () => {
        this.refreshScheduled = false
        void this.refresh()
      }
      // A new target must be collected after the current batch, which captured
      // its targets before this registration. Keep registrations coalesced.
      if (this.refreshPromise && this.refreshTargetRevision !== this.targetRevision)
        void this.refreshPromise.then(refresh, refresh)
      else refresh()
    })
  }

  private startLeaseRenewal(): void {
    if (this.leaseRenewalTimer !== null || typeof window === 'undefined') return
    this.leaseRenewalTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void this.refresh()
    }, OBSERVER_LEASE_RENEWAL_MS)
    this.visibilityListener = () => {
      this.synchronizeUiObservers()
      if (document.visibilityState === 'visible') void this.refresh()
    }
    document.addEventListener('visibilitychange', this.visibilityListener)
  }

  private stopLeaseRenewal(): void {
    if (this.leaseRenewalTimer === null || typeof window === 'undefined') return
    window.clearInterval(this.leaseRenewalTimer)
    this.leaseRenewalTimer = null
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
  const deviceId = target?.deviceId ?? null
  const taskId = target?.taskId ?? null
  const workspacePath = target?.workspacePath ?? null
  const remoteUrl = target?.remoteUrl ?? null
  const branch = target?.branch ?? null
  const changeRequestUrl = target?.changeRequestUrl

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!monitor) return () => undefined
      const unsubscribe = monitor.subscribe(listener)
      const unregister =
        deviceId && remoteUrl && (changeRequestUrl || (workspacePath && branch))
          ? monitor.register({
              deviceId,
              taskId: taskId ?? '',
              workspacePath: workspacePath ?? '',
              remoteUrl,
              branch: branch ?? '',
              ...(changeRequestUrl ? { changeRequestUrl } : {}),
            })
          : undefined
      return () => {
        unsubscribe()
        unregister?.()
      }
    },
    [branch, changeRequestUrl, deviceId, monitor, remoteUrl, taskId, workspacePath]
  )

  return useSyncExternalStore(
    subscribe,
    () => (monitor && target ? monitor.getSnapshot(target) : null),
    () => null
  )
}
