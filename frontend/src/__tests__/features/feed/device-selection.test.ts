// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { DeviceInfo } from '@/apis/devices'
import {
  getPreferredDevice,
  isSubscriptionDevice,
  sortDevicesForSelection,
} from '@/features/feed/components/subscription-form/device-selection'

function buildDevice(overrides: Partial<DeviceInfo>): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'device-1',
    status: 'online',
    is_default: false,
    device_type: 'local',
    connection_mode: 'websocket',
    slot_used: 0,
    slot_max: 3,
    running_tasks: [],
    executor_version: null,
    latest_version: null,
    update_available: false,
    ...overrides,
  }
}

describe('subscription device selection', () => {
  test('accepts local, cloud, and remote devices but not app devices', () => {
    expect(isSubscriptionDevice(buildDevice({ device_type: 'local' }))).toBe(true)
    expect(isSubscriptionDevice(buildDevice({ device_type: 'cloud' }))).toBe(true)
    expect(isSubscriptionDevice(buildDevice({ device_type: 'remote' }))).toBe(true)
    expect(isSubscriptionDevice(buildDevice({ device_type: 'app' }))).toBe(false)
  })

  test('keeps remote devices in the selectable list', () => {
    const devices = [
      buildDevice({ device_id: 'remote-1', name: 'remote-1', device_type: 'remote' }),
      buildDevice({ device_id: 'app-1', name: 'app-1', device_type: 'app' }),
    ]

    expect(sortDevicesForSelection(devices).map(device => device.device_id)).toEqual(['remote-1'])
  })

  test('orders devices by type, then default, then name', () => {
    const devices = [
      buildDevice({ device_id: 'remote-b', name: 'b-remote', device_type: 'remote' }),
      buildDevice({ device_id: 'cloud-b', name: 'b-cloud', device_type: 'cloud' }),
      buildDevice({ device_id: 'local-b', name: 'b-local', device_type: 'local' }),
      buildDevice({
        device_id: 'local-default',
        name: 'z-local',
        device_type: 'local',
        is_default: true,
      }),
      buildDevice({ device_id: 'local-a', name: 'a-local', device_type: 'local' }),
      buildDevice({ device_id: 'remote-a', name: 'a-remote', device_type: 'remote' }),
      buildDevice({ device_id: 'cloud-a', name: 'a-cloud', device_type: 'cloud' }),
    ]

    expect(sortDevicesForSelection(devices).map(device => device.device_id)).toEqual([
      'local-default',
      'local-a',
      'local-b',
      'cloud-a',
      'cloud-b',
      'remote-a',
      'remote-b',
    ])
  })

  test('prefers the first sorted device and falls back to a remote device', () => {
    expect(
      getPreferredDevice([
        buildDevice({ device_id: 'cloud-1', name: 'cloud-1', device_type: 'cloud' }),
        buildDevice({ device_id: 'local-1', name: 'local-1', device_type: 'local' }),
      ])?.device_id
    ).toBe('local-1')

    expect(
      getPreferredDevice([
        buildDevice({ device_id: 'remote-1', name: 'remote-1', device_type: 'remote' }),
      ])?.device_id
    ).toBe('remote-1')

    expect(getPreferredDevice([buildDevice({ device_id: 'app-1', device_type: 'app' })])).toBeNull()
  })
})
