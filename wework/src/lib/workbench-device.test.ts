import { describe, expect, test } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import {
  getExecutorOfflineDeviceId,
  getActiveWorkbenchDeviceId,
  getWorkbenchDeviceIds,
  findWorkbenchDevice,
  getWorkbenchDeviceUnavailableDisplayName,
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

  test('treats a busy device as online so new Runtime tasks can queue', () => {
    expect(isWorkbenchDeviceOnline(createDevice({ status: 'busy' }))).toBe(true)
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

  test('finds a device by its socket and runtime route aliases', () => {
    const device = createDevice({
      device_id: 'logical-device',
      app_device_id: 'app-device',
      socket_device_id: 'socket-device',
      runtime_instance_id: 'runtime-instance',
      runtime_routes: [
        {
          kind: 'cloud-relay',
          device_id: 'cloud-device',
          runtime_device_id: 'runtime-device',
          status: 'online',
        },
      ],
    })
    const devices = [device]

    expect(findWorkbenchDevice(devices, 'socket-device')?.device_id).toBe('logical-device')
    expect(findWorkbenchDevice(devices, 'runtime-device')?.device_id).toBe('logical-device')
    expect(getWorkbenchDeviceIds(device)).toEqual([
      'logical-device',
      'app-device',
      'socket-device',
      'runtime-instance',
      'cloud-device',
      'runtime-device',
    ])
  })

  test('uses the device IP for unavailable messages without exposing the device id', () => {
    const device = createDevice({
      device_id: '9562a3b4-61a3-4217-9655-0341b231eb06',
      name: 'sifang-executor-0341b231eb06',
      client_ip: '10.201.3.200',
    })

    expect(getWorkbenchDeviceUnavailableDisplayName(device)).toBe('10.201.3.200')
    expect(
      getExecutorOfflineDeviceId('executor-offline:9562a3b4-61a3-4217-9655-0341b231eb06')
    ).toBe('9562a3b4-61a3-4217-9655-0341b231eb06')
    expect(
      getWorkbenchDeviceUnavailableDisplayName(
        createDevice({
          device_id: '9562a3b4-61a3-4217-9655-0341b231eb06',
          name: 'sifang-executor-0341b231eb06',
        })
      )
    ).toBe('')
  })
})
