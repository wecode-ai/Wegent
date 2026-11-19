import {
  beginPluginDeviceSync,
  pluginDeviceSyncDiagnostic,
} from '@/features/plugins/pluginDeviceAutoSync'
import {
  reconcilePluginRefresh,
  type PluginReconciliationStage,
} from '@/features/plugins/pluginRefreshReconciliation'
import { logPluginRefreshPhase } from '@/features/plugins/pluginRefreshDiagnostics'

type ReconciliationOptions = Parameters<typeof reconcilePluginRefresh>[0]
export type RequestScope = { request: number; accountKey: string; deviceId: string }

function isNativeSyncBusy(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && error.code === 'plugin_local_sync_busy'
  )
}

export interface PluginRefreshReconciliationOptions {
  request: number
  accountKey: string
  deviceId: string
  available: boolean
  localSync?: boolean
  busy: boolean
  operations: Omit<ReconciliationOptions, 'isCurrent' | 'onProgress'>
  onComplete: () => void
  onError: (error: unknown) => void
}
type Admission = Pick<
  PluginRefreshReconciliationOptions,
  'request' | 'accountKey' | 'deviceId' | 'available' | 'busy' | 'localSync'
>
interface ActiveRequest {
  accountKey: string
  deviceId: string
  startedAt: number
  epoch: number
}

/** Run explicit refresh admissions while commit-owned scope ports fence every asynchronous step. */
interface OwnershipPort {
  readLatest(): PluginRefreshReconciliationOptions
  readEpoch(): number
  isMounted(): boolean
}
export function createPluginRefreshReconciliationModel() {
  let ownership: OwnershipPort | undefined
  const readLatest = () => {
    if (!ownership) throw new Error('Plugin refresh ownership is not bound')
    return ownership.readLatest()
  }
  const readEpoch = () => {
    if (!ownership) throw new Error('Plugin refresh ownership is not bound')
    return ownership.readEpoch()
  }
  const isMounted = () => ownership?.isMounted() ?? false
  const handled = { current: 0 }
  const lastRequest = { current: null as RequestScope | null }
  let active: ActiveRequest | null = null
  let stage: PluginReconciliationStage = 'waiting'
  let nativeDeferred = false
  let snapshot = { active, stage, nativeDeferred } as {
    active: ActiveRequest | null
    stage: PluginReconciliationStage
    nativeDeferred: boolean
  }
  const listeners = new Set<() => void>()
  const jobs = new Set<() => void>()
  const publish = () => {
    snapshot = { active, stage, nativeDeferred }
    listeners.forEach(listener => listener())
  }
  const setActive = (
    value: ActiveRequest | null | ((current: ActiveRequest | null) => ActiveRequest | null)
  ) => {
    const next = typeof value === 'function' ? value(active) : value
    if (next === active) return
    active = next
    publish()
  }
  const setStage = (next: PluginReconciliationStage) => {
    if (stage === next) return
    stage = next
    publish()
  }
  const setNativeDeferred = (next: boolean) => {
    if (nativeDeferred === next) return
    nativeDeferred = next
    publish()
  }
  const run = () => {
    const options = readLatest()
    const previous = lastRequest.current
    if (
      previous &&
      (!options.request ||
        previous.accountKey !== options.accountKey ||
        previous.deviceId !== options.deviceId)
    ) {
      handled.current = previous.request
    }
    lastRequest.current = options.request
      ? { request: options.request, accountKey: options.accountKey, deviceId: options.deviceId }
      : null
    if (!options.request || handled.current === options.request) {
      setActive(current => (current && current.epoch !== readEpoch() ? null : current))
      return
    }
    const owner = {
      accountKey: options.accountKey,
      deviceId: options.deviceId,
      startedAt: Date.now(),
      epoch: readEpoch(),
    }
    const clearActive = () => {
      setActive(current => (current === owner ? null : current))
    }
    setActive(owner)
    setStage('waiting')
    setNativeDeferred(false)
    logPluginRefreshPhase('reconcile-request', { request: options.request, busy: options.busy })
    if (options.busy) return clearActive
    if (!options.available || (!options.localSync && !options.deviceId)) {
      handled.current = options.request
      options.onError(new Error('Current device is offline; plugin state was not changed'))
      clearActive()
      return
    }
    const { accountKey, deviceId, request } = options
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    let acquired = false
    const deadline = Date.now() + 30_000
    const startedAt = Date.now()
    let waiting = false
    let nativeDeferrals = 0
    let deferredError: unknown
    const isCurrent = () =>
      !cancelled &&
      isMounted() &&
      readEpoch() === owner.epoch &&
      readLatest().accountKey === accountKey &&
      readLatest().deviceId === deviceId &&
      readLatest().request === request
    const finish = () => {
      jobs.delete(dispose)
      clearActive()
    }
    const start = () => {
      if (cancelled || !isCurrent()) return
      if (deferredError && Date.now() >= deadline) {
        readLatest().onError(deferredError)
        finish()
        return
      }
      const release = options.localSync
        ? () => undefined
        : beginPluginDeviceSync(deviceId, 'reconcile')
      if (!release) {
        if (!waiting) {
          waiting = true
          logPluginRefreshPhase('reconcile-lease-wait', {
            request,
            ...pluginDeviceSyncDiagnostic(deviceId),
          })
        }
        if (Date.now() >= deadline) {
          handled.current = request
          readLatest().onError(new Error('Plugin synchronization is busy; refresh again'))
          finish()
          return
        }
        timer = setTimeout(start, 250)
        return
      }
      handled.current = request
      acquired = true
      logPluginRefreshPhase('reconcile-start', { request, elapsedMs: Date.now() - startedAt })
      const current = readLatest()
      let deferred = false
      void reconcilePluginRefresh({
        ...current.operations,
        isCurrent,
        diagnosticRequest: request,
        onProgress: nextStage => {
          if (isCurrent()) {
            setStage(nextStage)
            setNativeDeferred(false)
          }
        },
      })
        .then(() => {
          if (isCurrent()) readLatest().onComplete()
        })
        .catch(error => {
          if (!isCurrent()) return
          if (isNativeSyncBusy(error) && Date.now() < deadline) {
            deferred = true
            deferredError = error
            nativeDeferrals += 1
            setStage('waiting')
            setNativeDeferred(true)
            logPluginRefreshPhase('reconcile-deferred', {
              request,
              busy: true,
              elapsedMs: Date.now() - startedAt,
            })
          } else {
            readLatest().onError(error)
          }
        })
        .finally(() => {
          logPluginRefreshPhase('reconcile-end', { request, elapsedMs: Date.now() - startedAt })
          release()
          if (deferred && isCurrent()) {
            const delay = Math.min(250 * 2 ** nativeDeferrals, 2000)
            timer = setTimeout(start, Math.max(0, Math.min(delay, deadline - Date.now())))
          } else finish()
        })
    }
    const dispose = () => {
      if (!jobs.has(dispose)) return
      // Availability and busy flags gate admission. Once acquired, the request
      // still owns its result until its account, device or request changes.
      if (
        acquired &&
        listeners.size > 0 &&
        isMounted() &&
        readEpoch() === owner.epoch &&
        readLatest().accountKey === accountKey &&
        readLatest().deviceId === deviceId &&
        readLatest().request === request
      ) {
        logPluginRefreshPhase('reconcile-gates-changed', { request, current: true })
        return
      }
      cancelled = true
      if (timer) clearTimeout(timer)
      finish()
    }
    jobs.add(dispose)
    start()
    return dispose
  }
  return {
    getSnapshot: () => snapshot,
    bindOwnership(port: OwnershipPort) {
      ownership = port
    },
    reader(admission: Admission) {
      return {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) {
          listeners.add(listener)
          if (!ownership) return () => listeners.delete(listener)
          const current = readLatest()
          const matching =
            current.accountKey === admission.accountKey &&
            current.deviceId === admission.deviceId &&
            current.request === admission.request &&
            current.busy === admission.busy &&
            current.available === admission.available &&
            current.localSync === admission.localSync
          const stop = matching ? run() : undefined
          return () => {
            listeners.delete(listener)
            // React replays subscriptions within a commit. Confirm the final
            // observer has left before cancelling an acquired native operation.
            queueMicrotask(() => {
              stop?.()
              if (!listeners.size) for (const dispose of jobs) dispose()
            })
          }
        },
      }
    },
  }
}
