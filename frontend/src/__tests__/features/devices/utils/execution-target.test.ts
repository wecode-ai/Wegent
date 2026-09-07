// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { DeviceInfo } from '@/apis/devices'
import {
  getAccountDefaultDeviceId,
  getPreferredExecutionDevice,
  getSelectableDevices,
  isDeviceAtCapacity,
  resolveTaskExecutionDeviceId,
  resolveDeviceSelectionId,
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
  it('resolves unique historical IDs without guessing between installations', () => {
    const first = createDevice({
      device_type: 'app',
      device_id: 'app-record-1',
      registered_device_id: 'local-device',
    })
    const second = createDevice({
      id: 2,
      device_type: 'app',
      device_id: 'app-record-2',
      registered_device_id: 'local-device',
    })
    expect(resolveDeviceSelectionId([first], 'local-device')).toBe('app-record-1')
    expect(resolveDeviceSelectionId([first, second], 'local-device')).toBe('local-device')
    expect(resolveDeviceSelectionId([first, second], 'app-record-2')).toBe('app-record-2')
    expect(resolveDeviceSelectionId([first], 'missing')).toBe('missing')
  })
  it('keeps the account default target exact without availability fallback', () => {
    expect(getAccountDefaultDeviceId('configured-offline-device')).toBe('configured-offline-device')
    expect(getAccountDefaultDeviceId('cloud')).toBeNull()
    expect(getAccountDefaultDeviceId(null)).toBeNull()
  })

  it('keeps an existing task on its persisted target', () => {
    expect(
      resolveTaskExecutionDeviceId({
        taskId: 42,
        persistedTaskDeviceId: 'task-device',
        newTaskDeviceId: 'stale-draft-device',
      })
    ).toBe('task-device')
    expect(
      resolveTaskExecutionDeviceId({
        taskId: 43,
        persistedTaskDeviceId: null,
        newTaskDeviceId: 'stale-draft-device',
      })
    ).toBeUndefined()
  })

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
