import { useCallback, useState, useSyncExternalStore } from 'react'
import { createDeviceOfflineLifecycleSource } from './deviceOfflineLifecycleSource'
import type { DeviceInfo } from '@/types/devices'

export const DEVICE_LIFECYCLE_POLL_INTERVAL_MS = 2_000
export const DEVICE_LIFECYCLE_TIMEOUT_MS = 120_000
export const DEVICE_LIFECYCLE_RECOVERED_NOTICE_MS = 2_200

export type DeviceLifecyclePhase =
  | 'idle'
  | 'submitting'
  | 'waiting-offline'
  | 'waiting-online'
  | 'recovered'
  | 'error'
  | 'timeout'

interface UseDeviceOfflineLifecycleActionOptions {
  status: DeviceInfo['status']
  runtimeInstanceId?: string | null
  requestAction: () => Promise<unknown>
  refreshDevices: () => void | Promise<void>
  pollIntervalMs?: number
  timeoutMs?: number
  recoveredNoticeMs?: number
}

export function useDeviceOfflineLifecycleAction({
  status,
  runtimeInstanceId,
  requestAction,
  refreshDevices,
  pollIntervalMs = DEVICE_LIFECYCLE_POLL_INTERVAL_MS,
  timeoutMs = DEVICE_LIFECYCLE_TIMEOUT_MS,
  recoveredNoticeMs = DEVICE_LIFECYCLE_RECOVERED_NOTICE_MS,
}: UseDeviceOfflineLifecycleActionOptions) {
  const [source] = useState(createDeviceOfflineLifecycleSource)
  const subscribe = useCallback(
    (listener: () => void) =>
      source.subscribe(listener, {
        status,
        runtimeInstanceId,
        requestAction,
        refreshDevices,
        pollIntervalMs,
        timeoutMs,
        recoveredNoticeMs,
      }),
    [
      source,
      status,
      runtimeInstanceId,
      requestAction,
      refreshDevices,
      pollIntervalMs,
      timeoutMs,
      recoveredNoticeMs,
    ]
  )
  const { phase, error } = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  return {
    phase,
    error,
    isPending: phase === 'submitting' || phase === 'waiting-offline' || phase === 'waiting-online',
    run: source.run,
    refreshAfterTimeout: source.refreshAfterTimeout,
  }
}
