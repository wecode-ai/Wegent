// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Device status utility functions.
 * Provides pure functions for mapping device status to UI styles.
 */

import { DeviceStatus } from '@/apis/devices'

/**
 * Get Tailwind CSS color class for device status indicator.
 *
 * @param status - Device status (online, busy, offline)
 * @returns Tailwind background color class (e.g., 'bg-green-500')
 */
export function getStatusColor(status: DeviceStatus | string): string {
  switch (status) {
    case 'online':
      return 'bg-green-500'
    case 'busy':
      return 'bg-yellow-500'
    default:
      return 'bg-gray-400'
  }
}
