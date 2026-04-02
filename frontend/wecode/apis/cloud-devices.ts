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
export interface VncConfig {
  wss_url: string
  signature: string
  sandbox_id: string
}

export interface CloudDeviceFileConfig {
  sandbox_id: string
  ip_address?: string | null
  files_url?: string | null
  available: boolean
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
  async getCloudDeviceStatus(deviceId: string): Promise<NevisSandboxStatus> {
    return apiClient.get(`/cloud-devices/${encodeURIComponent(deviceId)}/status`)
  },

  /**
   * Get cloud device configuration info.
   * Returns current configuration and limits for cloud devices.
   */
  async getCloudDeviceConfig(): Promise<CloudDeviceConfig> {
    return apiClient.get('/cloud-devices/config')
  },

  /**
   * Get VNC WebSocket connection configuration for a cloud device.
   * Returns the upstream WSS URL and authentication signature needed
   * to proxy VNC connections through server.cjs.
   *
   * @param deviceId - Cloud device ID (sandbox ID)
   */
  async getVncConfig(deviceId: string): Promise<VncConfig> {
    return apiClient.get(`/cloud-devices/${encodeURIComponent(deviceId)}/vnc-config`)
  },

  /**
   * Get cloud device file panel configuration.
   *
   * @param deviceId - Cloud device ID (UUID or sandbox ID)
   */
  async getFileConfig(deviceId: string): Promise<CloudDeviceFileConfig> {
    return apiClient.get(`/cloud-devices/${encodeURIComponent(deviceId)}/file-config`)
  },
}
