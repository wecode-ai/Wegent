// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from 'react'
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
    cloudDeviceApis
      .getCloudDeviceStatus(selectedDeviceId)
      .then(status => {
        if (!cancelled && status.sandbox_id) {
          setSandboxId(status.sandbox_id)
          // Auto-open VNC panel when sandbox_id is available
          setIsVncOpen(true)
        }
      })
      .catch(() => {
        // Silently handle - VNC toggle won't show if fetch fails
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
