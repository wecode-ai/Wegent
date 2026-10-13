import { describe, expect, test } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import {
  createWorkbenchDeviceResolver,
  mergeDeviceLists,
  workbenchDevicesShareRuntimeIdentity,
} from './workbench-device'

const device = (overrides: Partial<DeviceInfo>): DeviceInfo => ({
  id: 1,
  device_id: 'remote',
  name: 'Executor',
  status: 'online',
  device_type: 'remote',
  is_default: false,
  ...overrides,
})

describe('device identity resolution', () => {
  test('does not infer a known runtime identity from an address on a record without an identity', () => {
    const known = device({ device_id: 'shared-address', runtime_instance_id: 'runtime' })
    const unknown = device({ device_id: 'shared-address' })
    expect(workbenchDevicesShareRuntimeIdentity(known, unknown)).toBe(false)
    expect(workbenchDevicesShareRuntimeIdentity(unknown, known)).toBe(false)
    expect(mergeDeviceLists([known], [unknown])).toHaveLength(2)
    expect(() => createWorkbenchDeviceResolver([known, unknown]).resolve('shared-address')).toThrow(
      'ambiguous-executor-identity:shared-address'
    )
  })

  test('keeps equality independent of the selected connection when the persisted runtime is known', () => {
    const remote = device({ device_id: 'relay', runtime_instance_id: 'runtime' })
    const local = device({
      device_id: 'local',
      runtime_instance_id: 'runtime',
      device_type: 'local',
    })
    const remoteOnly = createWorkbenchDeviceResolver([remote])
    const connectedLocally = createWorkbenchDeviceResolver([local, remote])
    expect(remoteOnly.identityKey('relay')).toBe(connectedLocally.identityKey('local'))
    expect(connectedLocally.identityKey('relay')).toBe(connectedLocally.identityKey('local'))
    expect(connectedLocally.resolve('relay')?.device_id).toBe('local')
  })

  test('merges transitive aliases regardless of bridge record order', () => {
    const first = device({ device_id: 'local', device_type: 'local' })
    const second = device({ device_id: 'remote' })
    const bridge = device({ device_id: 'remote', app_device_id: 'local' })
    for (const records of [
      [first, second, bridge],
      [bridge, second, first],
      [second, first, bridge],
    ]) {
      expect(mergeDeviceLists(records, [])).toHaveLength(1)
      const resolver = createWorkbenchDeviceResolver(records)
      expect(resolver.resolve('remote')?.device_id).toBe('local')
      expect(resolver.identityKey('remote')).toBe(resolver.identityKey('local'))
    }
  })

  test('reports conflicting runtime ownership instead of selecting the first matching alias', () => {
    const resolver = createWorkbenchDeviceResolver([
      device({
        device_id: 'one',
        runtime_instance_id: 'runtime-one',
        socket_device_id: 'shared-route',
      }),
      device({
        device_id: 'two',
        runtime_instance_id: 'runtime-two',
        socket_device_id: 'shared-route',
      }),
    ])
    expect(() => resolver.resolve('shared-route')).toThrow(
      'ambiguous-executor-identity:shared-route'
    )
    expect(resolver.resolve('one')?.device_id).toBe('one')
    expect(resolver.resolve('two')?.device_id).toBe('two')
  })

  test('retains all input aliases even when the preferred record has another app alias', () => {
    const resolver = createWorkbenchDeviceResolver([
      device({
        device_id: 'local',
        device_type: 'local',
        runtime_instance_id: 'runtime',
        app_device_id: 'app-one',
      }),
      device({ device_id: 'remote', runtime_instance_id: 'runtime', app_device_id: 'app-two' }),
    ])
    expect(resolver.resolve('app-one')?.device_id).toBe('local')
    expect(resolver.resolve('app-two')?.device_id).toBe('local')
  })

  test('leaves unknown external hosts unresolved and distinct', () => {
    const resolver = createWorkbenchDeviceResolver([])
    expect(resolver.resolve('remote-ssh:one')).toBeNull()
    expect(resolver.identityKey('remote-ssh:one')).not.toBe(resolver.identityKey('remote-ssh:two'))
  })
})
