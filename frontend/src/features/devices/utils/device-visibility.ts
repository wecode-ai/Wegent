// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { DeviceInfo } from '@/apis/devices'
import { isOpenClawDevice } from './device-status'

/**
 * Hide advanced runtimes from ordinary execution choices until the user opts in.
 */
export function filterDevicesByAdvancedMode(
  devices: DeviceInfo[],
  showAdvancedDevices: boolean
): DeviceInfo[] {
  return showAdvancedDevices ? devices : devices.filter(device => !isOpenClawDevice(device))
}

export function resolveOrdinaryDeviceChatTarget(
  devices: DeviceInfo[],
  selectedDeviceId: string | null,
  defaultDeviceId: string | null
): string | null {
  const executorDevices = devices.filter(device => !isOpenClawDevice(device))
  if (executorDevices.some(device => device.device_id === selectedDeviceId)) {
    return selectedDeviceId
  }
  if (
    executorDevices.some(
      device =>
        device.device_id === defaultDeviceId || device.registered_device_id === defaultDeviceId
    )
  ) {
    return defaultDeviceId
  }
  return executorDevices.length === 1 ? executorDevices[0].device_id : null
}
