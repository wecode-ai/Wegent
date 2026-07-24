// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef } from 'react'
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import { useDevices } from '@/contexts/DeviceContext'

/**
 * Auto-select device when loading a task that was previously executed on a device.
 *
 * Device-mode tasks automatically select their saved device. Cloud tasks clear
 * global device state even if old data contains an incompatible device_id.
 */
export default function DeviceTaskSync() {
  const { selectedTaskDetail } = useTaskSession()
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

    const taskDeviceId =
      selectedTaskDetail.task_type === 'task' ? selectedTaskDetail.device_id : null

    // Cloud task or device task without a device — clear the global selection
    if (!taskDeviceId) {
      if (selectedDeviceId) {
        setSelectedDeviceId(null)
      }
      lastProcessedTaskIdRef.current = selectedTaskDetail.id
      return
    }

    // Skip if this device is already selected
    if (selectedDeviceId === taskDeviceId) {
      lastProcessedTaskIdRef.current = selectedTaskDetail.id
      return
    }

    // Check if the device exists in the devices list
    const deviceExists = devices.some(d => d.device_id === taskDeviceId)
    if (!deviceExists) {
      lastProcessedTaskIdRef.current = selectedTaskDetail.id
      return
    }

    // Auto-select the device
    setSelectedDeviceId(taskDeviceId)
    lastProcessedTaskIdRef.current = selectedTaskDetail.id
  }, [selectedTaskDetail, devices, selectedDeviceId, setSelectedDeviceId])

  return null // This component only handles synchronization
}
