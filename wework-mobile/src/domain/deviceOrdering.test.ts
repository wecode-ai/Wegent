import { describe, expect, it } from 'vitest'

import type { DeviceInfo } from '@/types/runtime'
import { onlineDevicesFirst } from './deviceOrdering'

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

function device(deviceId: string, status: DeviceInfo['status']): DeviceInfo {
  return {
    id: 1,
    device_id: deviceId,
    name: deviceId,
    status,
  }
}
