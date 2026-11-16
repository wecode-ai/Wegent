import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeSessionCache } from './runtimeSessionCache'
import { MobileRuntimeCache, type RuntimeCacheSnapshot } from './runtimeCache'
import type { DeviceInfo } from '@/types/runtime'
const files = vi.hoisted(() => new Map<string, string>())
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  getInfoAsync: async (path: string) => ({ exists: files.has(path) }),
  makeDirectoryAsync: async () => {},
  readAsStringAsync: async (path: string) => files.get(path),
  writeAsStringAsync: async (path: string, body: string) => {
    files.set(path, body)
  },
}))
const scope = 'a'.repeat(64)
const localId = `mobile-local:phone:${scope}`
const otherLocalId = `mobile-local:phone:${'b'.repeat(64)}`
const device = (device_id: string, rest: Partial<DeviceInfo> = {}): DeviceInfo => ({
  id: 1,
  device_id,
  name: device_id,
  status: 'online',
  device_type: 'local',
  bind_shell: 'claudecode',
  runtime_features: { schemaVersion: 1, embeddedRuntime: { version: 1 } },
  ...rest,
})
const work = { projects: [], chats: [], totalTasks: 1 }
const snapshot: RuntimeCacheSnapshot = {
  devices: [
    device(localId),
    device(otherLocalId),
    device('remote', { device_type: 'cloud' }),
    device('pc', {
      device_type: 'app',
      execution_target_id: 'app-record-1',
      runtime_features: {
        schemaVersion: 4,
        remoteTaskAccess: { version: 1, enabled: true, taskCreation: true },
      },
    }),
  ],
  models: [{ name: 'cloud-model', type: 'public' }],
  allDevicesSelected: true,
  selectedDeviceId: localId,
  workByDevice: { [localId]: work, [otherLocalId]: work, remote: work, 'app-record-1': work },
}
describe('phone and Backend cache ownership', () => {
  beforeEach(() => files.clear())
  it('retains phone history across Backend account changes while excluding foreign local scopes', async () => {
    const local = MobileRuntimeCache.local(scope)
    const userA = new MobileRuntimeCache('https://backend/api', 1)
    const userB = new MobileRuntimeCache('https://backend/api', 2)
    await new RuntimeSessionCache(local, userA, scope).write(snapshot)
    const offline = await new RuntimeSessionCache(local, null, scope).read()
    expect(offline.devices.map(row => row.device_id)).toEqual([localId])
    expect(Object.keys(offline.workByDevice)).toEqual([localId])
    const switched = await new RuntimeSessionCache(local, userB, scope).read()
    expect(switched.devices).toEqual(offline.devices)
    expect(switched.models).toEqual([])
    expect(
      (await userA.read()).devices.some(row => row.device_id.startsWith('mobile-local:'))
    ).toBe(false)
    expect(Object.keys((await userA.read()).workByDevice)).not.toContain(localId)
  })
  it('keeps APP work under its canonical execution target rather than its registration alias', async () => {
    const cache = new RuntimeSessionCache(
      MobileRuntimeCache.local(scope),
      new MobileRuntimeCache('https://backend/api', 1),
      scope
    )
    await cache.write(snapshot)
    const restored = await cache.read()
    expect(restored.workByDevice['app-record-1']).toEqual(work)
    expect(restored.selectedDeviceId).toBe(localId)
    expect(restored.allDevicesSelected).toBe(true)
  })
})
