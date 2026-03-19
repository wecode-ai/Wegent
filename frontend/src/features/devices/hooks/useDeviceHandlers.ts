// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom hook for device action handlers.
 * Consolidates all device-related actions (start task, set default, delete, cancel task)
 * to reduce prop drilling and centralize context dependencies.
 */

'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useSocket } from '@/contexts/SocketContext'
import { useDevices } from '@/contexts/DeviceContext'
import { DeviceInfo, deviceApis } from '@/apis/devices'
import { useTranslation } from '@/hooks/useTranslation'
import { isVersionAtLeast } from '@/lib/utils'

// Minimum executor version that supports auto-upgrade
const MIN_AUTO_UPGRADE_VERSION = '1.6.5'

/**
 * Device action handlers.
 */
export interface DeviceHandlers {
  handleStartTask: (deviceId: string) => void
  handleSetDefault: (device: DeviceInfo) => Promise<void>
  handleDeleteDevice: (device: DeviceInfo) => Promise<void>
  handleCancelTask: (taskId: number) => Promise<void>
  handleUpgradeDevice: (device: DeviceInfo) => Promise<void>
}

/**
 * Hook that provides all device action handlers.
 *
 * Usage:
 * ```tsx
 * const handlers = useDeviceHandlers()
 * <DeviceCard onStartTask={handlers.handleStartTask} ... />
 * ```
 *
 * @returns Object containing all device action handlers
 */
export function useDeviceHandlers(): DeviceHandlers {
  const { t } = useTranslation('devices')
  const router = useRouter()
  const { clearAllStreams } = useChatStreamContext()
  const { setSelectedTask } = useTaskContext()
  const { closeTaskSession } = useSocket()
  const { setSelectedDeviceId, setDefaultDevice, deleteDevice, refreshDevices } = useDevices()

  /**
   * Handle starting a task with a device.
   * Clears current task state and navigates to device chat page.
   *
   * @param deviceId - Device unique identifier
   */
  const handleStartTask = useCallback(
    (deviceId: string) => {
      setSelectedDeviceId(deviceId)
      setSelectedTask(null)
      clearAllStreams()
      router.push(`/devices/chat?deviceId=${deviceId}`)
    },
    [setSelectedDeviceId, setSelectedTask, clearAllStreams, router]
  )

  /**
   * Handle setting a device as default.
   * Shows success/error toast notification.
   *
   * @param device - Device to set as default
   */
  const handleSetDefault = useCallback(
    async (device: DeviceInfo) => {
      try {
        await setDefaultDevice(device.device_id)
        toast.success(t('set_default_success', { name: device.name }))
      } catch {
        toast.error(t('set_default_error'))
      }
    },
    [setDefaultDevice, t]
  )

  /**
   * Handle deleting a device.
   * Shows success/error toast notification.
   *
   * @param device - Device to delete
   */
  const handleDeleteDevice = useCallback(
    async (device: DeviceInfo) => {
      try {
        await deleteDevice(device.device_id)
        toast.success(t('delete_success', { name: device.name }))
      } catch {
        toast.error(t('delete_error'))
      }
    },
    [deleteDevice, t]
  )

  /**
   * Handle cancelling/closing a task via WebSocket.
   * - For running tasks: pauses execution
   * - For completed tasks: closes session and frees device slot
   *
   * @param taskId - Task ID to cancel/close
   */
  const handleCancelTask = useCallback(
    async (taskId: number) => {
      try {
        const result = await closeTaskSession(taskId)
        if (result.success) {
          toast.success(t('close_session_success'))
          // Refresh devices to update slot usage
          await refreshDevices()
        } else {
          toast.error(result.error || t('close_session_error'))
        }
      } catch (error) {
        console.error('Failed to close task session:', error)
        toast.error(t('close_session_error'))
      }
    },
    [closeTaskSession, refreshDevices, t]
  )

  /**
   * Handle triggering a device upgrade.
   *
   * @param device - Device to upgrade
   */
  const handleUpgradeDevice = useCallback(
    async (device: DeviceInfo) => {
      // Check if executor version supports auto-upgrade (>= 1.6.5)
      if (device.executor_version && !isVersionAtLeast(device.executor_version, MIN_AUTO_UPGRADE_VERSION)) {
        toast.error(t('upgrade.unsupportedVersion', {
          current: device.executor_version,
          required: MIN_AUTO_UPGRADE_VERSION
        }))
        return
      }

      try {
        await deviceApis.upgradeDevice(device.device_id, { auto_confirm: true })
        toast.success(t('upgrade.started'))
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : t('upgrade.failed')
        toast.error(errorMessage)
      }
    },
    [t]
  )

  return {
    handleStartTask,
    handleSetDefault,
    handleDeleteDevice,
    handleCancelTask,
    handleUpgradeDevice,
  }
}
