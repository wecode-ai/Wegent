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

// Device type enum matching backend DeviceType
export type DeviceType = 'local' | 'cloud'

// Bind shell type enum matching backend BindShell
export type BindShell = 'claudecode' | 'openclaw'

// Device connection mode enum matching backend DeviceConnectionMode
export type DeviceConnectionMode = 'websocket' // Future: 'api'

export interface DeviceRunningTask {
  task_id: number
  subtask_id: number
  title: string
  status: string
  created_at?: string
}

export interface CloudDeviceConfig {
  sandboxId: string
  imageId: string
  createdAt: string
}

export interface DeviceInfo {
  id: number
  device_id: string
  name: string
  status: DeviceStatus
  is_default: boolean
  last_heartbeat?: string
  // Device type and connection mode
  device_type: DeviceType
  connection_mode: DeviceConnectionMode
  capabilities?: string[]
  slot_used: number
  slot_max: number
  running_tasks: DeviceRunningTask[]
  // Version information
  executor_version: string | null
  latest_version: string | null
  update_available: boolean
  // Cloud device specific config
  cloud_config?: CloudDeviceConfig
  // Shell binding type
  bind_shell?: BindShell
}

export interface DeviceListResponse {
  items: DeviceInfo[]
  total: number
}

export interface UpgradeDeviceOptions {
  force?: boolean
  auto_confirm?: boolean
  verbose?: boolean
  force_stop_tasks?: boolean
  registry?: string
  registry_token?: string
}

export interface UpgradeDeviceResponse {
  success: boolean
  message: string
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

  /**
   * Trigger a remote upgrade for a device.
   *
   * @param deviceId - Device unique identifier
   * @param options - Upgrade options (force, auto_confirm, verbose, force_stop_tasks, registry, registry_token)
   */
  async upgradeDevice(
    deviceId: string,
    options?: UpgradeDeviceOptions
  ): Promise<UpgradeDeviceResponse> {
    return apiClient.post(`/devices/${encodeURIComponent(deviceId)}/upgrade`, options || {})
  },
}
