// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Cloud device API services.
 *
 * Provides methods for creating, deleting, and querying cloud devices
 * managed through Nevis Sandbox API.
 */

import { apiClient } from '@/apis/client'

/**
 * Response from cloud device creation
 */
export interface CloudDeviceResponse {
  id: number
  device_id: string
  name: string
  status: string
  device_type: 'cloud'
  message: string
}

/**
 * Nevis sandbox status information
 */
export interface NevisSandboxStatus {
  sandbox_id: string
  status: 'creating' | 'running' | 'stopped' | 'error' | string
  ip_address?: string
  vnc_url?: string
  created_at?: string
}

/**
 * Cloud device configuration info
 */
export interface CloudDeviceConfig {
  enabled: boolean
  max_devices_per_user: number
  can_create: boolean
}

/**
 * Request body for cloud device creation
 */
export interface CreateCloudDeviceRequest {
  mail_email?: string
  mail_password?: string
}

/**
 * VNC WebSocket connection configuration
 */
export interface VncSession {
  session_id: string
  device_id: string
  type: 'vnc'
  path: string
  url: string
  transport: 'websocket'
  expires_at?: string
}

export function validatedVncSessionUrl(session: VncSession): string {
  let url: URL
  try {
    url = new URL(session.url)
  } catch {
    throw new Error('Backend returned an invalid VNC session')
  }
  const queryKeys = Array.from(url.searchParams.keys())
  const safeSessionId = /^[A-Za-z0-9_-]+$/.test(session.session_id)
  if (
    session.type !== 'vnc' ||
    session.transport !== 'websocket' ||
    !safeSessionId ||
    !['ws:', 'wss:'].includes(url.protocol) ||
    Boolean(url.username || url.password || url.hash) ||
    url.pathname !== `/vnc-proxy/sessions/${session.session_id}` ||
    queryKeys.length !== 1 ||
    queryKeys[0] !== 'ticket' ||
    !url.searchParams.get('ticket')
  ) {
    throw new Error('Backend returned an invalid VNC session')
  }
  return url.toString()
}

export interface CloudDeviceFileConfig {
  sandbox_id: string
  ip_address?: string | null
  files_url?: string | null
  available: boolean
}

/**
 * Real-time resource utilization for a cloud device.
 * Values are percentages (0-100) or null when unavailable.
 */
export interface CloudDeviceMetricsResponse {
  cpu_usage: number | null
  memory_usage: number | null
  disk_usage: number | null
}

/**
 * 1-hour time series of resource utilization.
 * Each entry is [unix_seconds, percentage].
 */
export interface MetricsHistoryResponse {
  cpu: [number, number][]
  memory: [number, number][]
  disk: [number, number][]
}

function withOptionalUserId(path: string, userId?: number): string {
  if (userId == null) {
    return path
  }

  const params = new URLSearchParams({ user_id: String(userId) })
  return `${path}?${params.toString()}`
}

/**
 * Cloud device API services
 */
export const cloudDeviceApis = {
  /**
   * Create a new cloud device via Nevis Sandbox API.
   * Creates a VM with pre-installed wegent-executor.
   *
   * @param body - Optional request body with mail configuration
   */
  async createCloudDevice(body?: CreateCloudDeviceRequest): Promise<CloudDeviceResponse> {
    return apiClient.post('/cloud-devices', body)
  },

  /**
   * Delete a cloud device.
   * Deletes the VM via Nevis API and removes the device record.
   *
   * @param deviceId - Cloud device ID (sandbox ID)
   */
  async deleteCloudDevice(deviceId: string): Promise<{ message: string }> {
    return apiClient.delete(`/cloud-devices/${encodeURIComponent(deviceId)}`)
  },

  /**
   * Get Nevis sandbox status for a cloud device.
   * Queries Nevis API for the VM's current status.
   *
   * @param deviceId - Cloud device ID (sandbox ID)
   */
  async getCloudDeviceStatus(deviceId: string, userId?: number): Promise<NevisSandboxStatus> {
    return apiClient.get(
      withOptionalUserId(`/cloud-devices/${encodeURIComponent(deviceId)}/status`, userId)
    )
  },

  /**
   * Get cloud device configuration info.
   * Returns current configuration and limits for cloud devices.
   */
  async getCloudDeviceConfig(): Promise<CloudDeviceConfig> {
    return apiClient.get('/cloud-devices/config')
  },

  async startVncSession(deviceId: string, ownerUserId?: number): Promise<VncSession> {
    return apiClient.post(`/devices/${encodeURIComponent(deviceId)}/vnc`, {
      owner_user_id: ownerUserId,
    })
  },

  async revokeVncSession(sessionId: string): Promise<void> {
    return apiClient.delete(`/devices/vnc-sessions/${encodeURIComponent(sessionId)}`)
  },

  /**
   * Get cloud device file panel configuration.
   *
   * @param deviceId - Cloud device ID (UUID or sandbox ID)
   */
  async getFileConfig(deviceId: string, userId?: number): Promise<CloudDeviceFileConfig> {
    return apiClient.get(
      withOptionalUserId(`/cloud-devices/${encodeURIComponent(deviceId)}/file-config`, userId)
    )
  },

  /**
   * Get real-time CPU/memory/disk usage for a cloud device.
   * Does not require the device to be online.
   *
   * @param deviceId - Cloud device ID
   */
  async getMetrics(deviceId: string): Promise<CloudDeviceMetricsResponse> {
    return apiClient.post(`/cloud-devices/${encodeURIComponent(deviceId)}/metrics`)
  },

  /**
   * Get 1-hour usage history (time series) for a cloud device.
   *
   * @param deviceId - Cloud device ID
   */
  async getMetricsHistory(deviceId: string): Promise<MetricsHistoryResponse> {
    return apiClient.post(`/cloud-devices/${encodeURIComponent(deviceId)}/metrics/history`)
  },
}
