// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { useDevices } from '@/contexts/DeviceContext'

/**
 * Sync the deviceId URL parameter to DeviceContext.
 *
 * Reads `deviceId` or `device_id` from the URL search params and
 * sets it as the selected device when the device exists in the list.
 * This component only renders null and handles synchronization logic.
 */
export default function DeviceParamSync() {
  const searchParams = useSearchParams()
  const { devices, selectedDeviceId, setSelectedDeviceId } = useDevices()

  // Use ref to avoid re-running effect when selectedDeviceId changes
  const selectedDeviceIdRef = useRef(selectedDeviceId)
  selectedDeviceIdRef.current = selectedDeviceId

  // Track whether we've already synced for the current URL param
  const syncedParamRef = useRef<string | null>(null)

  useEffect(() => {
    const deviceId = searchParams.get('deviceId') || searchParams.get('device_id')

    if (!deviceId) return

    // Skip if we already synced this param value
    if (syncedParamRef.current === deviceId) return

    // Skip if already selected
    if (selectedDeviceIdRef.current === deviceId) {
      syncedParamRef.current = deviceId
      return
    }

    // Wait for devices to load, then validate and select
    if (devices.length === 0) return

    const deviceExists = devices.some((d) => d.device_id === deviceId)
    if (deviceExists) {
      setSelectedDeviceId(deviceId)
      syncedParamRef.current = deviceId
    }
  }, [searchParams, devices, setSelectedDeviceId])

  return null
}
