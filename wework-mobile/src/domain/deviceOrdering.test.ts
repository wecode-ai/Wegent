import { describe, expect, it } from 'vitest'

import type { DeviceInfo } from '@/types/runtime'
import {
  mobileCreatableDevices,
  mobileProjectCreatableDevices,
  mobileOperableDevices,
  onlineDevicesFirst,
  selectedOnlineDeviceId,
} from './deviceOrdering'

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
  it('creates tasks only on the online installation that advertises consent and creation support', () => {
    const app: DeviceInfo = {
      ...device('same-name', 'online'),
      device_type: 'app',
      execution_target_id: 'app-record-11',
      runtime_features: {
        schemaVersion: 4,
        remoteTaskAccess: { version: 1, enabled: true, taskCreation: true },
      },
    }
    expect(mobileCreatableDevices([app]).map(item => item.device_id)).toEqual(['app-record-11'])
    expect(mobileProjectCreatableDevices([app])).toEqual([])
    for (const invalid of [
      { ...app, status: 'offline' as const },
      {
        ...app,
        execution_target_id: 'app-record-22',
        runtime_features: {
          schemaVersion: 4,
          remoteTaskAccess: { version: 1 as const, enabled: false, taskCreation: true },
        },
      },
      {
        ...app,
        runtime_features: {
          schemaVersion: 4,
          remoteTaskAccess: { version: 1 as const, enabled: true, taskCreation: false },
        },
      },
    ]) {
      expect(mobileCreatableDevices([invalid])).toEqual([])
    }
  })

  it('uses each opted-in desktop installation route without mixing same-name computers', () => {
    const a: DeviceInfo = {
      ...device('shared-desktop-name', 'online'),
      device_type: 'app',
      execution_target_id: 'app-record-11',
      runtime_instance_id: 'runtime-a',
      runtime_features: { schemaVersion: 4, remoteTaskAccess: { version: 1, enabled: true } },
    }
    const b: DeviceInfo = {
      ...a,
      id: 2,
      execution_target_id: 'app-record-22',
      runtime_instance_id: 'runtime-b',
    }
    expect(mobileOperableDevices([a, b]).map(item => item.device_id)).toEqual([
      'app-record-11',
      'app-record-22',
    ])
    expect(
      mobileOperableDevices([
        a,
        {
          ...b,
          runtime_features: { schemaVersion: 4, remoteTaskAccess: { version: 1, enabled: false } },
        },
      ]).map(item => item.device_id)
    ).toEqual(['app-record-11'])
    expect(mobileOperableDevices([{ ...a, execution_target_id: null }])).toEqual([])
    expect(mobileCreatableDevices([a, b])).toEqual([])
    expect(
      mobileCreatableDevices([a, device('cloud', 'online')]).map(item => item.device_id)
    ).toEqual(['cloud'])
  })

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
