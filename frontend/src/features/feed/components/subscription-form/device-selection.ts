// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { DeviceInfo } from '@/apis/devices'
import type { SubscriptionExecutionTargetType } from '@/types/subscription'

export type SubscriptionDeviceType = Extract<
  DeviceInfo['device_type'],
  SubscriptionExecutionTargetType
>
export type SubscriptionDeviceInfo = DeviceInfo & { device_type: SubscriptionDeviceType }

const DEVICE_TYPE_RANK: Record<SubscriptionDeviceType, number> = {
  local: 0,
  cloud: 1,
  remote: 2,
}

export function isSubscriptionDevice(device: DeviceInfo): device is SubscriptionDeviceInfo {
  return (
    device.device_type === 'local' ||
    device.device_type === 'cloud' ||
    device.device_type === 'remote'
  )
}

export const sortDevicesForSelection = (devices: DeviceInfo[]): SubscriptionDeviceInfo[] =>
  devices.filter(isSubscriptionDevice).sort((left, right) => {
    const rankDiff = DEVICE_TYPE_RANK[left.device_type] - DEVICE_TYPE_RANK[right.device_type]
    if (rankDiff !== 0) {
      return rankDiff
    }
    if (left.is_default !== right.is_default) {
      return left.is_default ? -1 : 1
    }
    return left.name.localeCompare(right.name)
  })

export const getPreferredDevice = (devices: DeviceInfo[]): SubscriptionDeviceInfo | null =>
  sortDevicesForSelection(devices)[0] || null
