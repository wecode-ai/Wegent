// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef } from 'react'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useDevices } from '@/contexts/DeviceContext'

/**
 * Auto-select device when loading a task that was previously executed on a device.
 *
 * When a task has a device_id (saved from previous execution), this component
 * automatically selects that device so the user continues the conversation
 * on the same device.
 */
export default function DeviceTaskSync() {
  const { selectedTaskDetail } = useTaskContext()
  const { devices, selectedDeviceId, setSelectedDeviceId } = useDevices()

  // Track the last task ID we processed to avoid redundant updates
  const lastProcessedTaskIdRef = useRef<number | null>(null)

  useEffect(() => {
    // Skip if no task is selected
    if (!selectedTaskDetail) {
      return
    }

    // Skip if we already processed this task
    if (lastProcessedTaskIdRef.current === selectedTaskDetail.id) {
      return
    }

    // Task has no device_id — clear device selection
    if (!selectedTaskDetail.device_id) {
      if (selectedDeviceId) {
        setSelectedDeviceId(null)
      }
      lastProcessedTaskIdRef.current = selectedTaskDetail.id
      return
    }

    // Skip if this device is already selected
    if (selectedDeviceId === selectedTaskDetail.device_id) {
      lastProcessedTaskIdRef.current = selectedTaskDetail.id
      return
    }

    // Check if the device exists in the devices list
    const deviceExists = devices.some(d => d.device_id === selectedTaskDetail.device_id)
    if (!deviceExists) {
      lastProcessedTaskIdRef.current = selectedTaskDetail.id
      return
    }

    // Auto-select the device
    setSelectedDeviceId(selectedTaskDetail.device_id)
    lastProcessedTaskIdRef.current = selectedTaskDetail.id
  }, [selectedTaskDetail, devices, selectedDeviceId, setSelectedDeviceId])

  return null // This component only handles synchronization
}
