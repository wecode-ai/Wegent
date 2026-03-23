// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { DeviceInfo } from '@/apis/devices'
import {
  getPreferredExecutionDevice,
  getSelectableDevices,
  isDeviceAtCapacity,
} from '@/features/devices/utils/execution-target'

function createDevice(overrides: Partial<DeviceInfo>): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'Device 1',
    status: 'online',
    is_default: false,
    device_type: 'local',
    connection_mode: 'websocket',
    slot_used: 0,
    slot_max: 0,
    running_tasks: [],
    executor_version: null,
    latest_version: null,
    update_available: false,
    ...overrides,
  }
}

describe('execution target utils', () => {
  it('sorts selectable devices by local first, then cloud, while keeping offline devices out', () => {
    const devices = [
      createDevice({
        id: 1,
        device_id: 'cloud-online',
        name: 'Cloud Online',
        device_type: 'cloud',
      }),
      createDevice({
        id: 2,
        device_id: 'local-offline',
        name: 'Local Offline',
        status: 'offline',
      }),
      createDevice({
        id: 3,
        device_id: 'local-online',
        name: 'Local Online',
      }),
    ]

    expect(getSelectableDevices(devices).map(device => device.device_id)).toEqual([
      'local-online',
      'cloud-online',
    ])
  })

  it('prefers an explicitly marked default device when it is selectable', () => {
    const devices = [
      createDevice({
        id: 1,
        device_id: 'local-online',
        name: 'Local Online',
      }),
      createDevice({
        id: 2,
        device_id: 'cloud-default',
        name: 'Cloud Default',
        device_type: 'cloud',
        status: 'busy',
        is_default: true,
      }),
    ]

    expect(getPreferredExecutionDevice(devices)?.device_id).toBe('cloud-default')
  })

  it('falls back to the first online device in execution order when no default is set', () => {
    const devices = [
      createDevice({
        id: 1,
        device_id: 'cloud-online',
        name: 'Cloud Online',
        device_type: 'cloud',
      }),
      createDevice({
        id: 2,
        device_id: 'local-busy',
        name: 'Local Busy',
        status: 'busy',
      }),
      createDevice({
        id: 3,
        device_id: 'local-online',
        name: 'Local Online',
      }),
    ]

    expect(getPreferredExecutionDevice(devices)?.device_id).toBe('local-online')
  })

  it('does not auto-select devices that are already at capacity', () => {
    const fullDefaultDevice = createDevice({
      id: 1,
      device_id: 'local-default-full',
      name: 'Local Default Full',
      is_default: true,
      slot_used: 1,
      slot_max: 1,
    })
    const cloudOnlineDevice = createDevice({
      id: 2,
      device_id: 'cloud-online',
      name: 'Cloud Online',
      device_type: 'cloud',
    })

    expect(isDeviceAtCapacity(fullDefaultDevice.slot_used, fullDefaultDevice.slot_max)).toBe(true)
    expect(getPreferredExecutionDevice([fullDefaultDevice, cloudOnlineDevice])?.device_id).toBe(
      'cloud-online'
    )
  })
})
