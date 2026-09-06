import { describe, expect, it } from 'vitest'

import type { DeviceInfo } from '@/types/runtime'
import { mobileOperableDevices, onlineDevicesFirst, selectedOnlineDeviceId } from './deviceOrdering'

describe('onlineDevicesFirst', () => {
  it('places online and busy devices before offline devices while preserving group order', () => {
    const devices: DeviceInfo[] = [
      device('offline-1', 'offline'),
      device('online-1', 'online'),
      device('offline-2', 'offline'),
      device('busy-1', 'busy'),
      device('online-2', 'online'),
    ]

    const result = onlineDevicesFirst(devices)

    expect(result.map(item => item.device_id)).toEqual([
      'online-1',
      'busy-1',
      'online-2',
      'offline-1',
      'offline-2',
    ])
    expect(devices.map(item => item.device_id)).toEqual([
      'offline-1',
      'online-1',
      'offline-2',
      'busy-1',
      'online-2',
    ])
  })
})

describe('selectedOnlineDeviceId', () => {
  const devices = [device('offline', 'offline'), device('first', 'online'), device('busy', 'busy')]

  it('preserves the preferred online device', () => {
    expect(selectedOnlineDeviceId(devices, 'busy')).toBe('busy')
  })

  it('selects the first online device when the preferred device is unavailable', () => {
    expect(selectedOnlineDeviceId(devices, 'offline')).toBe('first')
  })
})

describe('mobileOperableDevices', () => {
  it('keeps Claude Code remote executors while removing unsupported registrations and shells', () => {
    const devices = [
      { ...device('app', 'online'), device_type: 'app' as const },
      { ...device('local', 'online'), device_type: 'local' as const },
      device('cloud', 'online'),
      { ...device('remote', 'online'), device_type: 'remote' as const },
      { ...device('openclaw', 'online'), bind_shell: 'openclaw' as const },
    ]

    expect(mobileOperableDevices(devices).map(item => item.device_id)).toEqual(['cloud', 'remote'])
  })
})

function device(deviceId: string, status: DeviceInfo['status']): DeviceInfo {
  return {
    id: 1,
    device_id: deviceId,
    name: deviceId,
    status,
    device_type: 'cloud',
    bind_shell: 'claudecode',
  }
}
