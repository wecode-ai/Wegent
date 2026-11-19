import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  createPluginRefreshReconciliationModel,
  type PluginRefreshReconciliationOptions,
} from './pluginRefreshReconciliationModel'

export function usePluginRefreshReconciliation(options: PluginRefreshReconciliationOptions) {
  const [model] = useState(createPluginRefreshReconciliationModel)
  const latest = useRef(options)
  const scopeEpoch = useRef(0)
  const mounted = useRef(true)
  useLayoutEffect(() => {
    const previous = latest.current
    if (
      previous.accountKey !== options.accountKey ||
      previous.deviceId !== options.deviceId ||
      previous.request !== options.request
    )
      scopeEpoch.current += 1
    latest.current = options
    model.bindOwnership({
      readLatest: () => latest.current,
      readEpoch: () => scopeEpoch.current,
      isMounted: () => mounted.current,
    })
  })

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const source = useMemo(
    () =>
      model.reader({
        request: options.request,
        accountKey: options.accountKey,
        deviceId: options.deviceId,
        available: options.available,
        busy: options.busy,
        localSync: options.localSync,
      }),
    [
      model,
      options.request,
      options.accountKey,
      options.deviceId,
      options.available,
      options.busy,
      options.localSync,
    ]
  )
  const { active, stage, nativeDeferred } = useSyncExternalStore(
    source.subscribe,
    source.getSnapshot,
    source.getSnapshot
  )
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
