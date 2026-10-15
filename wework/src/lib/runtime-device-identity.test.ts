import { describe, expect, test, vi } from 'vitest'
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
  test('preserves independent source groups with malformed record ids and rejects their shared alias', () => {
    const one = device({
      id: undefined as never,
      device_id: 'one',
      app_device_id: 'shared-malformed',
    })
    const two = device({ id: Number.NaN, device_id: 'two', app_device_id: 'shared-malformed' })
    const resolver = createWorkbenchDeviceResolver([one, two])
    expect(resolver.resolve('one')?.device_id).toBe('one')
    expect(resolver.resolve('two')?.device_id).toBe('two')
    expect(() => resolver.resolve('shared-malformed')).toThrow(
      'ambiguous-executor-identity:shared-malformed'
    )
    expect(mergeDeviceLists([one], [two])).toHaveLength(2)
  })

  test('keeps two legacy registrations with missing runtime identities independent even when aliases overlap', () => {
    const one = device({ id: 1, device_id: 'legacy-one', app_device_id: 'shared-legacy' })
    const two = device({ id: 2, device_id: 'legacy-two', app_device_id: 'shared-legacy' })
    expect(workbenchDevicesShareRuntimeIdentity(one, two)).toBe(false)
    expect(mergeDeviceLists([one], [two])).toHaveLength(2)
    expect(() => createWorkbenchDeviceResolver([one, two]).resolve('shared-legacy')).toThrow(
      'ambiguous-executor-identity:shared-legacy'
    )
    expect(createWorkbenchDeviceResolver([one]).resolve('shared-legacy')?.device_id).toBe(
      'legacy-one'
    )
  })

  test('only deduplicates legacy snapshots of the same persisted registration and canonical address', () => {
    const original = device({ id: 1, device_id: 'legacy-one', socket_device_id: 'old-route' })
    const snapshot = device({ id: 1, device_id: 'legacy-one', socket_device_id: 'new-route' })
    expect(mergeDeviceLists([original], [snapshot])).toHaveLength(1)
    expect(
      workbenchDevicesShareRuntimeIdentity(original, device({ id: 2, device_id: 'legacy-one' }))
    ).toBe(false)
    expect(
      workbenchDevicesShareRuntimeIdentity(
        original,
        device({ id: 1, device_id: 'other-address', socket_device_id: 'old-route' })
      )
    ).toBe(false)
  })

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
    const first = device({
      device_id: 'local',
      device_type: 'local',
      runtime_instance_id: 'shared-runtime',
    })
    const second = device({ device_id: 'remote', runtime_instance_id: 'shared-runtime' })
    const bridge = device({
      device_id: 'remote',
      app_device_id: 'local',
      runtime_instance_id: 'shared-runtime',
    })
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

  test('includes only safe candidate identity fields in ambiguity diagnostics', () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const records = ['one', 'two'].map((runtime, index) => ({
      ...device({
        id: index + 1,
        device_id: runtime,
        app_device_id: 'shared',
        runtime_instance_id: runtime,
        error: 'secret error contents',
      }),
      token: 'secret-token',
      modelConfig: { apiKey: 'secret-model-key' },
      auth: { session: 'secret-session' },
    }))
    let error: unknown
    try {
      createWorkbenchDeviceResolver(records).resolve('shared')
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({
      message: 'ambiguous-executor-identity:shared',
      details: {
        candidates: records.map(record => ({
          recordId: record.id,
          type: 'remote',
          status: 'online',
          device_id: record.device_id,
          app_device_id: 'shared',
          socket_device_id: null,
          runtime_instance_id: record.runtime_instance_id,
          routeKind: 'remote-relay',
        })),
      },
    })
    expect(JSON.stringify(error)).not.toContain('secret error contents')
    expect(log).toHaveBeenCalledWith('[Wework] Ambiguous executor identity', {
      deviceId: 'shared',
      candidates: (error as { details: { candidates: unknown[] } }).details.candidates,
    })
    const serialized = JSON.stringify(log.mock.calls)
    expect(serialized).toContain('runtime_instance_id')
    expect(serialized).not.toMatch(/secret error contents|token|modelConfig|auth/)
    log.mockRestore()
  })
})
