import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { getRuntimeConfig } from '@/config/runtime'
import type { DeviceInfo } from '@/types/devices'
import {
  resetLocalExecutorStartupCheck,
  startLocalExecutorStartupCheck,
} from './local-executor-startup'

export const ONBOARDING_POLL_INTERVAL_MS = 5_000
export const ONBOARDING_TIMEOUT_MS = 5 * 60_000

export function hasOnlineDevice(devices: DeviceInfo[]): boolean {
  return devices.some(device => device.status === 'online')
}

interface UseDeviceOnboardingOptions {
  onReady: () => void
}

export interface DeviceOnboardingState {
  timedOut: boolean
  creatingCloud: boolean
  cloudError: string | null
  createCloudDevice: () => void
  retry: () => void
}

export function useDeviceOnboarding({
  onReady,
}: UseDeviceOnboardingOptions): DeviceOnboardingState {
  const deviceApi = useMemo(() => {
    const { apiBaseUrl } = getRuntimeConfig()
    return createDeviceApi(createHttpClient({ baseUrl: apiBaseUrl }))
  }, [])

  const [pollEpoch, setPollEpoch] = useState(0)
  const [timedOut, setTimedOut] = useState(false)
  const [creatingCloud, setCreatingCloud] = useState(false)
  const [cloudError, setCloudError] = useState<string | null>(null)

  const onReadyRef = useRef(onReady)
  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])
  const readyRef = useRef(false)
  // When the user creates a cloud device, the hard timeout no longer applies:
  // cloud provisioning can exceed 5 minutes, so we keep polling.
  const cloudRequestedRef = useRef(false)

  // Trigger local device creation (install + start executor) once on mount.
  useEffect(() => {
    void startLocalExecutorStartupCheck()
  }, [])

  useEffect(() => {
    readyRef.current = false
    const startedAt = Date.now()
    let intervalId = 0

    const stop = () => {
      if (intervalId) {
        window.clearInterval(intervalId)
        intervalId = 0
      }
    }

    const poll = async () => {
      let devices: DeviceInfo[]
      try {
        devices = await deviceApi.listDevices()
      } catch {
        return
      }
      if (readyRef.current) return

      if (hasOnlineDevice(devices)) {
        readyRef.current = true
        stop()
        onReadyRef.current()
        return
      }

      if (!cloudRequestedRef.current && Date.now() - startedAt >= ONBOARDING_TIMEOUT_MS) {
        stop()
        setTimedOut(true)
      }
    }

    void poll()
    intervalId = window.setInterval(() => void poll(), ONBOARDING_POLL_INTERVAL_MS)

    return stop
  }, [deviceApi, pollEpoch])

  const restartPolling = useCallback(() => {
    setTimedOut(false)
    setPollEpoch(epoch => epoch + 1)
  }, [])

  const retry = useCallback(() => {
    cloudRequestedRef.current = false
    setCloudError(null)
    void resetLocalExecutorStartupCheck()
    restartPolling()
  }, [restartPolling])

  const createCloudDevice = useCallback(() => {
    if (creatingCloud) return
    setCreatingCloud(true)
    setCloudError(null)
    void deviceApi
      .createCloudDevice()
      .then(() => {
        cloudRequestedRef.current = true
        // Resume polling in case the timeout already fired before the click.
        restartPolling()
      })
      .catch((error: unknown) => {
        setCloudError(error instanceof Error ? error.message : 'Failed to create cloud device')
      })
      .finally(() => {
        setCreatingCloud(false)
      })
  }, [creatingCloud, deviceApi, restartPolling])

  return { timedOut, creatingCloud, cloudError, createCloudDevice, retry }
}
