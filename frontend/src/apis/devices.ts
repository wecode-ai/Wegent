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

export type VersionStatus = 'up_to_date' | 'update_available' | 'incompatible'

export interface SystemStats {
  memory_used_mb: number
  memory_total_mb: number
  memory_percent: number
  disk_used_gb: number
  disk_total_gb: number
  disk_free_gb: number
  disk_percent: number
  workspace_size_mb: number
  workspace_count: number
  log_size_mb: number
  cpu_percent: number
  uptime_seconds: number
}

export interface TaskStats {
  running_tasks: number
  queued_tasks: number
  completed_today: number
}

export interface DeviceInfo {
  id: number
  device_id: string
  name: string
  status: DeviceStatus
  is_default: boolean
  last_heartbeat?: string
  capabilities?: string[]
  executor_version?: string
  version_status?: VersionStatus
  system_stats?: SystemStats
  task_stats?: TaskStats
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
}
