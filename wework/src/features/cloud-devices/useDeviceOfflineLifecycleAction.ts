import { useCallback, useEffect, useRef, useState } from 'react'
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
  recoveryReady?: boolean
  requestAction: () => Promise<unknown>
  refreshDevices: () => void | Promise<void>
  pollIntervalMs?: number
  timeoutMs?: number
  recoveredNoticeMs?: number
}

function isConnectedStatus(status: DeviceInfo['status']): boolean {
  return status === 'online' || status === 'busy'
}

export function useDeviceOfflineLifecycleAction({
  status,
  recoveryReady = true,
  requestAction,
  refreshDevices,
  pollIntervalMs = DEVICE_LIFECYCLE_POLL_INTERVAL_MS,
  timeoutMs = DEVICE_LIFECYCLE_TIMEOUT_MS,
  recoveredNoticeMs = DEVICE_LIFECYCLE_RECOVERED_NOTICE_MS,
}: UseDeviceOfflineLifecycleActionOptions) {
  const [phase, setPhase] = useState<DeviceLifecyclePhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const deadlineRef = useRef(0)

  useEffect(() => {
    const nextPhase =
      phase === 'waiting-offline' && status === 'offline'
        ? 'waiting-online'
        : phase === 'waiting-online' && isConnectedStatus(status) && recoveryReady
          ? 'recovered'
          : null
    if (!nextPhase) return
    const timer = window.setTimeout(() => {
      setPhase(currentPhase => (currentPhase === phase ? nextPhase : currentPhase))
    }, 0)
    return () => window.clearTimeout(timer)
  }, [phase, recoveryReady, status])

  useEffect(() => {
    if (phase !== 'waiting-offline' && phase !== 'waiting-online') return

    let cancelled = false
    let timer = 0
    const poll = async () => {
      if (Date.now() >= deadlineRef.current) {
        setPhase('timeout')
        return
      }
      try {
        await refreshDevices()
      } catch (refreshError) {
        console.error('Failed to refresh devices during lifecycle action:', refreshError)
      }
      if (!cancelled) {
        timer = window.setTimeout(poll, pollIntervalMs)
      }
    }

    timer = window.setTimeout(poll, pollIntervalMs)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [phase, pollIntervalMs, refreshDevices])

  useEffect(() => {
    if (phase !== 'recovered') return
    const timer = window.setTimeout(() => setPhase('idle'), recoveredNoticeMs)
    return () => window.clearTimeout(timer)
  }, [phase, recoveredNoticeMs])

  const run = useCallback(async (): Promise<boolean> => {
    setPhase('submitting')
    setError(null)
    try {
      await requestAction()
      deadlineRef.current = Date.now() + timeoutMs
      setPhase(status === 'offline' ? 'waiting-online' : 'waiting-offline')
      void Promise.resolve(refreshDevices()).catch(refreshError => {
        console.error('Failed to refresh devices after lifecycle request:', refreshError)
      })
      return true
    } catch (actionError) {
      console.error('Device lifecycle action failed:', actionError)
      setError(actionError instanceof Error ? actionError.message : String(actionError))
      setPhase('error')
      return false
    }
  }, [refreshDevices, requestAction, status, timeoutMs])

  const refreshAfterTimeout = useCallback(async () => {
    deadlineRef.current = Date.now() + timeoutMs
    setPhase('waiting-online')
    await refreshDevices()
  }, [refreshDevices, timeoutMs])

  const reset = useCallback(() => {
    deadlineRef.current = 0
    setError(null)
    setPhase('idle')
  }, [])

  return {
    error,
    isPending: phase === 'submitting' || phase === 'waiting-offline' || phase === 'waiting-online',
    phase,
    refreshAfterTimeout,
    reset,
    run,
  }
}
