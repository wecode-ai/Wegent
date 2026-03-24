// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { DeviceInfo } from '@/apis/devices'

const DEVICE_TYPE_PRIORITY: Record<DeviceInfo['device_type'], number> = {
  local: 0,
  cloud: 1,
}

export function isDeviceAtCapacity(slotUsed: number, slotMax: number) {
  return slotMax > 0 && slotUsed >= slotMax
}

export function formatSlotUsage(slotUsed: number, slotMax: number) {
  return slotMax > 0 ? `${slotUsed}/${slotMax}` : `${slotUsed}/∞`
}

export function getStatusColor(status: DeviceInfo['status']) {
  switch (status) {
    case 'online':
      return 'bg-green-500'
    case 'busy':
      return 'bg-yellow-500'
    default:
      return 'bg-gray-400'
  }
}

export function compareDevicesByExecutionPriority(left: DeviceInfo, right: DeviceInfo) {
  if (left.device_type !== right.device_type) {
    return DEVICE_TYPE_PRIORITY[left.device_type] - DEVICE_TYPE_PRIORITY[right.device_type]
  }

  if (left.status === 'online' && right.status !== 'online') return -1
  if (left.status !== 'online' && right.status === 'online') return 1

  if (left.is_default !== right.is_default) {
    return left.is_default ? -1 : 1
  }

  return left.name.localeCompare(right.name)
}

export function getSelectableDevices(devices: DeviceInfo[]) {
  return devices
    .filter(device => device.status !== 'offline')
    .sort(compareDevicesByExecutionPriority)
}

export function getPreferredExecutionDevice(devices: DeviceInfo[]) {
  const selectableDevices = getSelectableDevices(devices)

  const defaultDevice = selectableDevices.find(
    device => device.is_default && !isDeviceAtCapacity(device.slot_used, device.slot_max)
  )
  if (defaultDevice) {
    return defaultDevice
  }

  return (
    selectableDevices.find(
      device => device.status === 'online' && !isDeviceAtCapacity(device.slot_used, device.slot_max)
    ) || null
  )
}
