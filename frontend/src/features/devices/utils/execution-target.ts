// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { DeviceInfo } from '@/apis/devices'

const DEVICE_TYPE_PRIORITY: Record<DeviceInfo['device_type'], number> = {
  local: 0,
  cloud: 1,
  remote: 2,
  app: 3,
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

/**
 * Convert the account-level default into a new-task device selection.
 *
 * `null` represents managed cloud execution. A configured device id is kept
 * verbatim even when the device is currently offline or absent from discovery;
 * silently substituting another target would change the user's explicit choice.
 */
export function getAccountDefaultDeviceId(
  defaultExecutionTarget: string | null | undefined
): string | null {
  const target = defaultExecutionTarget?.trim()
  return target && target !== 'cloud' ? target : null
}

/** Resolve a historical ID only when it identifies exactly one registration. */
export function resolveDeviceSelectionId(
  devices: DeviceInfo[],
  deviceId: string | null | undefined
): string | null {
  if (!deviceId) return null
  if (devices.some(device => device.device_id === deviceId)) return deviceId
  const matches = devices.filter(device => device.registered_device_id === deviceId)
  return matches.length === 1 ? matches[0].device_id : deviceId
}

export function resolveTaskExecutionDeviceId({
  taskId,
  persistedTaskDeviceId,
  newTaskDeviceId,
}: {
  taskId: number | null | undefined
  persistedTaskDeviceId: string | null | undefined
  newTaskDeviceId: string | null | undefined
}): string | undefined {
  const deviceId = taskId ? persistedTaskDeviceId : newTaskDeviceId
  return deviceId?.trim() || undefined
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
