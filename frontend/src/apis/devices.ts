// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Device API services for local device management.
 */

import { apiClient } from './client'
import { DeviceInfo } from '@/types/socket'

export interface DeviceListResponse {
  items: DeviceInfo[]
  total: number
}

/**
 * Device API services
 */
export const deviceApis = {
  /**
   * Get current user's online devices.
   * Only returns devices that are currently connected.
   */
  async getOnlineDevices(): Promise<DeviceListResponse> {
    return apiClient.get('/devices/online')
  },
}
