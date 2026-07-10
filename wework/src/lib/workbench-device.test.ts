import { describe, expect, test } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import {
  getActiveWorkbenchDeviceId,
  findWorkbenchDevice,
  isWorkbenchDeviceOnline,
  resolveLocalWorkbenchDeviceId,
} from './workbench-device'

function createDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'Local Executor',
    status: 'online',
    is_default: true,
    device_type: 'local',
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
    ...overrides,
  }
}

describe('workbench-device', () => {
  test('treats a missing configured device as unavailable', () => {
    const devices: DeviceInfo[] = []
    const device = findWorkbenchDevice(devices, 'missing-device')

    expect(device).toBeNull()
    expect(isWorkbenchDeviceOnline(device)).toBe(false)
  })

  test('uses the project configured device before standalone fallback', () => {
    expect(
      getActiveWorkbenchDeviceId({
        currentProject: {
          id: 7,
          name: 'Wegent',
          config: { execution: { targetType: 'local', deviceId: 'project-device' } },
        },
        standaloneDeviceId: 'standalone-device',
      })
    ).toBe('project-device')

    expect(
      getActiveWorkbenchDeviceId({
        currentProject: null,
        standaloneDeviceId: 'standalone-device',
      })
    ).toBe('standalone-device')
  })

  test('resolves the local-device CLI alias to the real local executor device', () => {
    const devices = [
      createDevice({
        device_id: 'device-real-local',
        name: 'This Mac',
        device_type: 'local',
        status: 'online',
      }),
      createDevice({
        id: 2,
        device_id: 'cloud-1',
        name: 'Cloud',
        device_type: 'cloud',
        is_default: false,
      }),
    ]

    expect(resolveLocalWorkbenchDeviceId(devices, 'local-device')).toBe('device-real-local')
    expect(findWorkbenchDevice(devices, 'local-device')).toMatchObject({
      device_id: 'device-real-local',
      status: 'online',
    })
    expect(isWorkbenchDeviceOnline(findWorkbenchDevice(devices, 'local-device'))).toBe(true)
  })

  test('keeps an exact local-device match when the executor reports that id', () => {
    const devices = [createDevice({ device_id: 'local-device' })]

    expect(resolveLocalWorkbenchDeviceId(devices, 'local-device')).toBe('local-device')
    expect(findWorkbenchDevice(devices, 'local-device')?.device_id).toBe('local-device')
  })
})
