import { useEffect, useRef, useState } from 'react'
import { beginPluginDeviceSync } from '@/features/plugins/pluginDeviceAutoSync'
import { reconcilePluginRefresh } from '@/features/plugins/pluginRefreshReconciliation'

type ReconciliationOptions = Parameters<typeof reconcilePluginRefresh>[0]

export function usePluginRefreshReconciliation(options: {
  request: number
  accountKey: string
  deviceId: string
  available: boolean
  busy: boolean
  operations: Omit<ReconciliationOptions, 'isCurrent'>
  onComplete: () => void
  onError: (error: unknown) => void
}) {
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })
  const handled = useRef(0)
  const mounted = useRef(true)
  const [active, setActive] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    const options = latest.current
    if (!options.request || handled.current === options.request || options.busy) return
    if (!options.available || !options.deviceId) {
      handled.current = options.request
      options.onError(new Error('Current device is offline; plugin state was not changed'))
      return
    }
    const { accountKey, deviceId, request } = options
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    const deadline = Date.now() + 30_000
    const isCurrent = () =>
      mounted.current &&
      latest.current.accountKey === accountKey &&
      latest.current.deviceId === deviceId
    const start = () => {
      if (cancelled || !isCurrent()) return
      const release = beginPluginDeviceSync(deviceId)
      if (!release) {
        if (Date.now() >= deadline) {
          handled.current = request
          latest.current.onError(new Error('Plugin synchronization is busy; refresh again'))
          return
        }
        timer = setTimeout(start, 250)
        return
      }
      handled.current = request
      setActive(true)
      const current = latest.current
      void reconcilePluginRefresh({ ...current.operations, isCurrent })
        .then(() => {
          if (isCurrent()) latest.current.onComplete()
        })
        .catch(error => {
          if (isCurrent()) latest.current.onError(error)
        })
        .finally(() => {
          release()
          if (mounted.current) setActive(false)
        })
    }
    start()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [options.request, options.accountKey, options.deviceId, options.available, options.busy])
  return active
}
