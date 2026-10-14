import { describe, expect, test } from 'vitest'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'
import {
  getLocalRuntimeSourceIdentity,
  qualifyLocalRuntimeSource,
} from './local-runtime-sidebar-identity'
import {
  createWorkbenchDeviceResolver,
  getExecutorOfflineDeviceId,
  getActiveWorkbenchDeviceId,
  getWorkbenchDeviceIds,
  getWorkbenchDeviceNamesById,
  getRuntimeWorkDeviceNamesById,
  findWorkbenchDevice,
  findNativeLocalWorkbenchDevice,
  mergeDeviceLists,
  getWorkbenchDeviceUnavailableDisplayName,
  isWorkbenchDeviceOnline,
  resolveLocalWorkbenchDeviceId,
  resolveWorkbenchDeviceId,
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
  test('uses native IPC provenance for the exact local address while keeping remote resolution strict', () => {
    const identity = {
      deviceId: 'current-ipc',
      runtimeInstanceId: 'current-runtime',
      provenance: 'local-ipc' as const,
    }
    const local = qualifyLocalRuntimeSource(
      createDevice({
        device_id: identity.deviceId,
        runtime_instance_id: identity.runtimeInstanceId,
      }),
      identity
    )
    const remote = createDevice({
      id: 2,
      device_id: 'historical-remote',
      socket_device_id: identity.deviceId,
      runtime_instance_id: 'historical-runtime',
      device_type: 'remote',
      status: 'offline',
    })
    const merged = mergeDeviceLists([local], [remote])

    expect(findNativeLocalWorkbenchDevice(merged, identity.deviceId)).toMatchObject({
      device_type: 'local',
      runtime_instance_id: identity.runtimeInstanceId,
    })
    expect(findWorkbenchDevice(merged, identity.deviceId)).toBeNull()
    expect(() => createWorkbenchDeviceResolver(merged).resolve(identity.deviceId)).toThrow(
      'ambiguous-executor-identity:current-ipc'
    )
    expect(findWorkbenchDevice(merged, remote.device_id)?.runtime_instance_id).toBe(
      remote.runtime_instance_id
    )
    expect(getLocalRuntimeSourceIdentity(merged[1])).toBeUndefined()
  })

  test('denies ambiguous display resolution without trusting JSON or a stale native identity', () => {
    const identity = {
      deviceId: 'current-ipc',
      runtimeInstanceId: 'current-runtime',
      provenance: 'local-ipc' as const,
    }
    const local = qualifyLocalRuntimeSource(
      createDevice({
        device_id: identity.deviceId,
        runtime_instance_id: identity.runtimeInstanceId,
      }),
      identity
    )
    const remote = createDevice({
      id: 2,
      device_id: 'remote',
      app_device_id: identity.deviceId,
      runtime_instance_id: 'other-runtime',
      device_type: 'remote',
    })
    for (const untrustedLocal of [
      JSON.parse(JSON.stringify(local)) as DeviceInfo,
      { ...local, runtime_instance_id: 'replacement-runtime' },
    ]) {
      expect(findNativeLocalWorkbenchDevice([untrustedLocal, remote], identity.deviceId)).toBeNull()
      expect(findWorkbenchDevice([untrustedLocal, remote], identity.deviceId)).toBeNull()
      expect(() =>
        createWorkbenchDeviceResolver([untrustedLocal, remote]).resolve(identity.deviceId)
      ).toThrow('ambiguous-executor-identity:current-ipc')
    }
    const replacement = qualifyLocalRuntimeSource(
      { ...local, runtime_instance_id: 'replacement-runtime' },
      { ...identity, runtimeInstanceId: 'replacement-runtime' }
    )
    expect(findNativeLocalWorkbenchDevice([remote, replacement], identity.deviceId)).toBe(
      replacement
    )
  })

  test('does not use trusted local provenance to resolve an ambiguous remote alias', () => {
    const identity = {
      deviceId: 'current-ipc',
      runtimeInstanceId: 'current-runtime',
      provenance: 'local-ipc' as const,
    }
    const local = qualifyLocalRuntimeSource(
      createDevice({
        device_id: identity.deviceId,
        socket_device_id: 'shared-remote-route',
        runtime_instance_id: identity.runtimeInstanceId,
      }),
      identity
    )
    const remote = createDevice({
      id: 2,
      device_id: 'remote',
      socket_device_id: 'shared-remote-route',
      runtime_instance_id: 'other-runtime',
      device_type: 'remote',
    })
    expect(findWorkbenchDevice([local, remote], 'shared-remote-route')).toBeNull()
    expect(() =>
      createWorkbenchDeviceResolver([local, remote]).resolve('shared-remote-route')
    ).toThrow('ambiguous-executor-identity:shared-remote-route')
  })

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
    expect(resolveWorkbenchDeviceId(devices, 'runtime-device')).toBe('logical-device')
    expect(resolveWorkbenchDeviceId(devices, 'unknown-device')).toBe('unknown-device')
    expect(getWorkbenchDeviceIds(device)).toEqual([
      'logical-device',
      'app-device',
      'socket-device',
      'runtime-instance',
      'cloud-device',
      'runtime-device',
    ])
    expect(getWorkbenchDeviceNamesById(devices)).toMatchObject({
      'logical-device': 'Local Executor',
      'app-device': 'Local Executor',
      'socket-device': 'Local Executor',
      'runtime-instance': 'Local Executor',
      'cloud-device': 'Local Executor',
      'runtime-device': 'Local Executor',
    })
  })

  test('indexes runtime workspace names by the routed device id', () => {
    const runtimeWork = {
      projects: [
        {
          deviceWorkspaces: [
            {
              deviceId: 'runtime-device',
              deviceName: 'Local Executor',
            },
          ],
        },
      ],
      chats: [{ deviceId: 'chat-device', deviceName: 'Chat Executor' }],
    } as RuntimeWorkListResponse

    expect(getRuntimeWorkDeviceNamesById(runtimeWork)).toEqual({
      'runtime-device': 'Local Executor',
      'chat-device': 'Chat Executor',
    })
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
