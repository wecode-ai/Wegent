// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useDevices } from '@/contexts/DeviceContext'
import { useTaskSession } from '@/features/tasks/session/TaskSession'

/**
 * Sync the deviceId URL parameter to DeviceContext.
 *
 * Reads `deviceId` or `device_id` from the URL search params and
 * sets it as the selected device when the device exists in the list.
 * This component only renders null and handles synchronization logic.
 */
export default function DeviceParamSync() {
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const { devices, selectedDeviceId, setSelectedDeviceId } = useDevices()
  const { selectedTaskDetail } = useTaskSession()

  // Use ref to avoid re-running effect when selectedDeviceId changes
  const selectedDeviceIdRef = useRef(selectedDeviceId)
  selectedDeviceIdRef.current = selectedDeviceId

  // Track whether we've already synced for the current URL param
  const syncedParamRef = useRef<string | null>(null)

  useEffect(() => {
    const deviceId = searchParams.get('deviceId') || searchParams.get('device_id')

    if (!deviceId) return

    const taskId =
      searchParams.get('taskId') || searchParams.get('task_id') || searchParams.get('taskid')
    const isLoadedCloudTask =
      !!taskId &&
      String(selectedTaskDetail?.id) === taskId &&
      selectedTaskDetail?.task_type !== 'task'

    if (isLoadedCloudTask) {
      if (selectedDeviceIdRef.current) {
        setSelectedDeviceId(null)
      }
      const nextParams = new URLSearchParams(searchParams.toString())
      nextParams.delete('deviceId')
      nextParams.delete('device_id')
      const query = nextParams.toString()
      router.replace(query ? `${pathname}?${query}` : pathname)
      syncedParamRef.current = null
      return
    }

    // Skip if we already synced this param value
    if (syncedParamRef.current === deviceId) return

    // Skip if already selected
    if (selectedDeviceIdRef.current === deviceId) {
      syncedParamRef.current = deviceId
      return
    }

    // Wait for devices to load, then validate and select
    if (devices.length === 0) return

    const deviceExists = devices.some(d => d.device_id === deviceId)
    if (deviceExists) {
      setSelectedDeviceId(deviceId)
      syncedParamRef.current = deviceId
    }
  }, [searchParams, pathname, router, devices, selectedTaskDetail, setSelectedDeviceId])

  return null
}
