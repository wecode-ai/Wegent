import { describe, expect, test } from 'vitest'
import {
  getPreferredStandaloneDeviceId,
  isWeWorkSelectableStandaloneDevice,
} from './device-selection'

describe('device-selection', () => {
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
})
