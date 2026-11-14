import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
type RequestScope = { request: number; accountKey: string; deviceId: string }

function isNativeSyncBusy(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && error.code === 'plugin_local_sync_busy'
  )
}

export function usePluginRefreshReconciliation(options: {
  request: number
  accountKey: string
  deviceId: string
  available: boolean
  localSync?: boolean
  busy: boolean
  operations: Omit<ReconciliationOptions, 'isCurrent' | 'onProgress'>
  onComplete: () => void
  onError: (error: unknown) => void
}) {
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  })
  const handled = useRef(0)
  const lastRequest = useRef<RequestScope | null>(null)
  const mounted = useRef(true)
  const [active, setActive] = useState<{
    accountKey: string
    deviceId: string
    startedAt: number
  } | null>(null)
  const [stage, setStage] = useState<PluginReconciliationStage>('waiting')
  const [nativeDeferred, setNativeDeferred] = useState(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    const options = latest.current
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
    if (!options.request || handled.current === options.request) return
    const owner = {
      accountKey: options.accountKey,
      deviceId: options.deviceId,
      startedAt: Date.now(),
    }
    const clearActive = () => {
      if (mounted.current) setActive(current => (current === owner ? null : current))
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
    const deadline = Date.now() + 30_000
    const startedAt = Date.now()
    let waiting = false
    let nativeDeferrals = 0
    let deferredError: unknown
    const isCurrent = () =>
      !cancelled &&
      mounted.current &&
      latest.current.available &&
      !latest.current.busy &&
      latest.current.accountKey === accountKey &&
      latest.current.deviceId === deviceId &&
      latest.current.request === request
    const start = () => {
      if (cancelled || !isCurrent()) return
      if (deferredError && Date.now() >= deadline) {
        handled.current = request
        latest.current.onError(deferredError)
        clearActive()
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
          latest.current.onError(new Error('Plugin synchronization is busy; refresh again'))
          clearActive()
          return
        }
        timer = setTimeout(start, 250)
        return
      }
      logPluginRefreshPhase('reconcile-start', { request, elapsedMs: Date.now() - startedAt })
      const current = latest.current
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
          if (isCurrent()) {
            handled.current = request
            latest.current.onComplete()
          }
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
            handled.current = request
            latest.current.onError(error)
          }
        })
        .finally(() => {
          logPluginRefreshPhase('reconcile-end', { request, elapsedMs: Date.now() - startedAt })
          release()
          if (deferred && isCurrent()) {
            const delay = Math.min(250 * 2 ** nativeDeferrals, 2000)
            timer = setTimeout(start, Math.max(0, Math.min(delay, deadline - Date.now())))
          } else clearActive()
        })
    }
    start()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      clearActive()
    }
  }, [
    options.request,
    options.accountKey,
    options.deviceId,
    options.available,
    options.busy,
    options.localSync,
  ])
  const isActive = Boolean(
    active && active.accountKey === options.accountKey && active.deviceId === options.deviceId
  )
  return {
    active: isActive,
    waitingOnNative: isActive && nativeDeferred && stage === 'waiting',
    stage,
    startedAt: active?.startedAt ?? null,
  }
}
