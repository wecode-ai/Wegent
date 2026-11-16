// @vitest-environment node

import { describe, expect, test } from 'vitest'
import {
  getPreferredStandaloneDeviceId,
  isWeWorkSelectableStandaloneDevice,
} from './device-selection'

describe('device-selection', () => {
  function selectableDevice(
    overrides: Partial<Parameters<typeof isWeWorkSelectableStandaloneDevice>[0]> = {}
  ) {
    return {
      device_id: 'device-1',
      name: 'Device',
      status: 'online',
      device_type: 'local',
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
      ...overrides,
    }
  }

  test('does not select an online standalone device below the WeWork executor version', () => {
    const devices = [
      {
        device_id: 'old-device',
        name: 'Old Device',
        status: 'online',
        device_type: 'cloud',
        bind_shell: 'claudecode',
        executor_version: '1.8.4',
      },
      {
        device_id: 'new-device',
        name: 'New Device',
        status: 'online',
        device_type: 'local',
        bind_shell: 'claudecode',
        executor_version: '1.8.5',
      },
    ]

    expect(isWeWorkSelectableStandaloneDevice(devices[0])).toBe(false)
    expect(getPreferredStandaloneDeviceId(devices, 'old-device')).toBe('new-device')
  })

  test('does not select a local device below the WeWork executor version when a cloud device is compatible', () => {
    const devices = [
      selectableDevice({ device_id: 'cloud-device', name: 'Cloud Device', device_type: 'cloud' }),
      selectableDevice({
        device_id: 'old-local-device',
        name: 'Old Local Device',
        device_type: 'local',
        executor_version: '1.8.4',
      }),
    ]

    expect(getPreferredStandaloneDeviceId(devices)).toBeNull()
  })
})
