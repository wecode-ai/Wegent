// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useRef } from 'react'
import { cloudDeviceApis } from '@wecode/apis'

interface Device {
  device_id: string
  device_type?: string
  status?: string
}

interface UseDeviceVncStateOptions {
  selectedDevice: Device | undefined
  selectedDeviceId: string | null
}

/**
 * Hook to manage VNC state for cloud devices
 * Handles fetching sandbox_id and auto-opening VNC panel
 */
export function useDeviceVncState({ selectedDevice, selectedDeviceId }: UseDeviceVncStateOptions) {
  const [isVncOpen, setIsVncOpen] = useState(false)
  const [sandboxId, setSandboxId] = useState<string | null>(null)
  const lastAutoOpenedDeviceIdRef = useRef<string | null>(null)

  // Determine if current device is a cloud device
  const isCloudDevice = selectedDevice?.device_type === 'cloud'

  // Fetch sandbox_id when a cloud device is selected
  useEffect(() => {
    if (!isCloudDevice || !selectedDeviceId || selectedDevice?.status === 'offline') {
      setSandboxId(null)
      setIsVncOpen(false)
      return
    }

    let cancelled = false
    setSandboxId(null)

    cloudDeviceApis
      .getCloudDeviceStatus(selectedDeviceId)
      .then(status => {
        if (cancelled) {
          return
        }

        const nextSandboxId = status.sandbox_id ?? null
        setSandboxId(nextSandboxId)

        if (nextSandboxId && lastAutoOpenedDeviceIdRef.current !== selectedDeviceId) {
          setIsVncOpen(true)
          lastAutoOpenedDeviceIdRef.current = selectedDeviceId
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSandboxId(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [selectedDeviceId, isCloudDevice, selectedDevice?.status])

  const handleToggleVnc = () => {
    setIsVncOpen(prev => !prev)
  }

  return {
    isCloudDevice,
    isVncOpen,
    sandboxId,
    setIsVncOpen,
    handleToggleVnc,
  }
}
