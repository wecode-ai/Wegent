// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Device API services for local device management.
 *
 * Devices are stored as Device CRD in the backend kinds table.
 * Online status is managed via Redis with heartbeat mechanism.
 */

import { apiClient } from './client'

export type DeviceStatus = 'online' | 'offline' | 'busy'

export interface DeviceRunningTask {
  task_id: number
  subtask_id: number
  title: string
  status: string
  created_at?: string
}

export interface DeviceInfo {
  id: number
  device_id: string
  name: string
  status: DeviceStatus
  is_default: boolean
  last_heartbeat?: string
  capabilities?: string[]
  slot_used: number
  slot_max: number
  running_tasks: DeviceRunningTask[]
}

export interface DeviceListResponse {
  items: DeviceInfo[]
  total: number
}

/**
 * Device API services
 */
export const deviceApis = {
  /**
   * Get all devices for the current user (including offline).
   * Returns all registered devices with their current online status.
   */
  async getAllDevices(): Promise<DeviceListResponse> {
    return apiClient.get('/devices')
  },

  /**
   * Get only online devices for the current user.
   * For backward compatibility.
   */
  async getOnlineDevices(): Promise<DeviceListResponse> {
    return apiClient.get('/devices/online')
  },

  /**
   * Set a device as the default executor.
   * Only one device can be default at a time.
   *
   * @param deviceId - Device unique identifier
   */
  async setDefaultDevice(deviceId: string): Promise<{ message: string }> {
    return apiClient.put(`/devices/${encodeURIComponent(deviceId)}/default`)
  },

  /**
   * Delete a device registration.
   * Note: If the device reconnects via WebSocket, it will be re-registered.
   *
   * @param deviceId - Device unique identifier
   */
  async deleteDevice(deviceId: string): Promise<{ message: string }> {
    return apiClient.delete(`/devices/${encodeURIComponent(deviceId)}`)
  },

  /**
   * Cancel a running task or close session for completed tasks.
   *
   * - For running tasks: This will pause the task execution
   * - For completed tasks: This will close the session and free up the device slot
   *
   * The backend automatically determines the action based on task status.
   *
   * @param taskId - Task ID to cancel/close
   */
  async cancelTask(taskId: number): Promise<{ message: string; status: string }> {
    return apiClient.post(`/tasks/${taskId}/cancel`)
  },
}
