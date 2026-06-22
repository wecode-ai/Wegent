import { describe, expect, test } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import {
  getActiveWorkbenchDeviceId,
  findWorkbenchDevice,
  isWorkbenchDeviceOnline,
} from './workbench-device'

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
})
