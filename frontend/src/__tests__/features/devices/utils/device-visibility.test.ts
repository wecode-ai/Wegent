// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { DeviceInfo } from '@/apis/devices'
import {
  filterDevicesByAdvancedMode,
  resolveOrdinaryDeviceChatTarget,
} from '@/features/devices/utils/device-visibility'

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
    slot_max: 1,
    running_tasks: [],
    executor_version: null,
    latest_version: null,
    update_available: false,
    bind_shell: 'claudecode',
    ...overrides,
  }
}

describe('device visibility', () => {
  it('retains an ambiguous legacy default instead of switching to cloud or another device', () => {
    const devices = [
      createDevice({
        device_type: 'app',
        device_id: 'app-record-1',
        registered_device_id: 'local-device',
      }),
      createDevice({
        id: 2,
        device_type: 'app',
        device_id: 'app-record-2',
        registered_device_id: 'local-device',
      }),
    ]
    expect(resolveOrdinaryDeviceChatTarget(devices, null, 'local-device')).toBe('local-device')
  })
  it('hides OpenClaw from ordinary choices', () => {
    const executor = createDevice({ device_id: 'executor' })
    const openclaw = createDevice({
      id: 2,
      device_id: 'openclaw',
      bind_shell: 'openclaw',
    })

    expect(filterDevicesByAdvancedMode([executor, openclaw], false)).toEqual([executor])
  })

  it('shows OpenClaw after advanced mode is enabled', () => {
    const devices = [
      createDevice({ device_id: 'executor' }),
      createDevice({ id: 2, device_id: 'openclaw', bind_shell: 'openclaw' }),
    ]

    expect(filterDevicesByAdvancedMode(devices, true)).toEqual(devices)
  })

  it('ignores an OpenClaw default and auto-selects the sole Executor', () => {
    const devices = [
      createDevice({ device_id: 'executor' }),
      createDevice({ id: 2, device_id: 'openclaw', bind_shell: 'openclaw' }),
    ]

    expect(resolveOrdinaryDeviceChatTarget(devices, 'openclaw', 'openclaw')).toBe('executor')
  })

  it('does not arbitrarily choose between multiple Executors', () => {
    const devices = [
      createDevice({ device_id: 'executor-1' }),
      createDevice({ id: 2, device_id: 'executor-2' }),
    ]

    expect(resolveOrdinaryDeviceChatTarget(devices, null, null)).toBeNull()
    expect(resolveOrdinaryDeviceChatTarget(devices, null, 'executor-2')).toBe('executor-2')
  })
})
