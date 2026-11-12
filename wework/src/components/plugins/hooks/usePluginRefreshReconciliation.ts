import { useEffect, useRef, useState } from 'react'
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
  useEffect(() => {
    latest.current = options
  })
  const handled = useRef(0)
  const mounted = useRef(true)
  const [active, setActive] = useState<{
    accountKey: string
    deviceId: string
    startedAt: number
  } | null>(null)
  const [stage, setStage] = useState<PluginReconciliationStage>('waiting')
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    const options = latest.current
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
    const isCurrent = () =>
      !cancelled &&
      mounted.current &&
      latest.current.accountKey === accountKey &&
      latest.current.deviceId === deviceId &&
      latest.current.request === request
    const start = () => {
      if (cancelled || !isCurrent()) return
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
      handled.current = request
      acquired = true
      logPluginRefreshPhase('reconcile-start', { request, elapsedMs: Date.now() - startedAt })
      const current = latest.current
      void reconcilePluginRefresh({
        ...current.operations,
        isCurrent,
        diagnosticRequest: request,
        onProgress: nextStage => {
          if (isCurrent()) setStage(nextStage)
        },
      })
        .then(() => {
          if (isCurrent()) latest.current.onComplete()
        })
        .catch(error => {
          if (isCurrent()) latest.current.onError(error)
        })
        .finally(() => {
          logPluginRefreshPhase('reconcile-end', { request, elapsedMs: Date.now() - startedAt })
          release()
          clearActive()
        })
    }
    start()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      if (!acquired) clearActive()
    }
  }, [
    options.request,
    options.accountKey,
    options.deviceId,
    options.available,
    options.busy,
    options.localSync,
  ])
  return {
    active: Boolean(
      active && active.accountKey === options.accountKey && active.deviceId === options.deviceId
    ),
    stage,
    startedAt: active?.startedAt ?? null,
  }
}
