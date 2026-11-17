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
  runtimeInstanceId?: string | null
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
  runtimeInstanceId,
  requestAction,
  refreshDevices,
  pollIntervalMs = DEVICE_LIFECYCLE_POLL_INTERVAL_MS,
  timeoutMs = DEVICE_LIFECYCLE_TIMEOUT_MS,
  recoveredNoticeMs = DEVICE_LIFECYCLE_RECOVERED_NOTICE_MS,
}: UseDeviceOfflineLifecycleActionOptions) {
  const [phase, setPhase] = useState<DeviceLifecyclePhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const deadlineRef = useRef(0)
  const startingInstanceRef = useRef<string | null | undefined>(null)
  const pendingRef = useRef(false)
  const timedOutPhaseRef = useRef<'waiting-offline' | 'waiting-online'>('waiting-offline')

  useEffect(() => {
    const instanceChanged = Boolean(
      startingInstanceRef.current &&
      runtimeInstanceId &&
      startingInstanceRef.current !== runtimeInstanceId
    )
    const recoveryConfirmed =
      startingInstanceRef.current && runtimeInstanceId
        ? instanceChanged
        : phase === 'waiting-online'
    const nextPhase =
      (phase === 'waiting-online' || phase === 'waiting-offline') &&
      recoveryConfirmed &&
      isConnectedStatus(status)
        ? 'recovered'
        : phase === 'waiting-offline' && status === 'offline'
          ? 'waiting-online'
          : null
    if (!nextPhase) return
    const timer = window.setTimeout(() => {
      if (nextPhase === 'recovered') pendingRef.current = false
      setPhase(currentPhase => (currentPhase === phase ? nextPhase : currentPhase))
    }, 0)
    return () => window.clearTimeout(timer)
  }, [phase, runtimeInstanceId, status])

  useEffect(() => {
    if (phase !== 'waiting-offline' && phase !== 'waiting-online') return

    let cancelled = false
    let timer = 0
    const poll = async () => {
      if (Date.now() >= deadlineRef.current) {
        pendingRef.current = false
        timedOutPhaseRef.current = phase
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
    if (pendingRef.current) return false
    pendingRef.current = true
    startingInstanceRef.current = runtimeInstanceId
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
      pendingRef.current = false
      console.error('Device lifecycle action failed:', actionError)
      setError(actionError instanceof Error ? actionError.message : String(actionError))
      setPhase('error')
      return false
    }
  }, [refreshDevices, requestAction, runtimeInstanceId, status, timeoutMs])

  const refreshAfterTimeout = useCallback(async () => {
    pendingRef.current = true
    deadlineRef.current = Date.now() + timeoutMs
    setPhase(timedOutPhaseRef.current)
    await refreshDevices()
  }, [refreshDevices, timeoutMs])

  return {
    error,
    isPending: phase === 'submitting' || phase === 'waiting-offline' || phase === 'waiting-online',
    phase,
    refreshAfterTimeout,
    run,
  }
}
