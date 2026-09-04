import { beforeEach, describe, expect, it, vi } from 'vitest'

const files = new Map<string, string>()

vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  getInfoAsync: vi.fn(async (path: string) => ({ exists: files.has(path) })),
  makeDirectoryAsync: vi.fn(async () => undefined),
  readAsStringAsync: vi.fn(async (path: string) => files.get(path) ?? ''),
  writeAsStringAsync: vi.fn(async (path: string, value: string) => {
    files.set(path, value)
  }),
}))

import { MobileRuntimeCache } from './runtimeCache'

describe('MobileRuntimeCache', () => {
  beforeEach(() => files.clear())

  it('persists the selected device and each device work independently', async () => {
    const cache = new MobileRuntimeCache('https://wegent.example/api', 7)
    await cache.write({
      allDevicesSelected: true,
      devices: [
        {
          id: 1,
          device_id: 'device-1',
          name: 'Mac',
          status: 'online',
          device_type: 'remote',
          bind_shell: 'openclaw',
        },
      ],
      models: [{ name: 'gpt', type: 'public' }],
      selectedDeviceId: null,
      workByDevice: {
        'device-1': { projects: [], chats: [], totalTasks: 0 },
        'device-2': { projects: [], chats: [], totalTasks: 2 },
      },
    })

    await expect(cache.read()).resolves.toMatchObject({
      allDevicesSelected: true,
      selectedDeviceId: null,
      devices: [{ device_id: 'device-1', device_type: 'remote', bind_shell: 'openclaw' }],
      workByDevice: {
        'device-1': { totalTasks: 0 },
        'device-2': { totalTasks: 2 },
      },
    })
  })

  it('keeps caches isolated by backend and user', async () => {
    await new MobileRuntimeCache('https://wegent.example/api', 7).write({
      allDevicesSelected: false,
      devices: [
        {
          id: 1,
          device_id: 'private',
          name: 'Private',
          status: 'online',
          device_type: 'cloud',
          bind_shell: 'claudecode',
        },
      ],
      models: [],
      selectedDeviceId: 'private',
      workByDevice: {},
    })

    await expect(new MobileRuntimeCache('https://wegent.example/api', 8).read()).resolves.toEqual({
      allDevicesSelected: false,
      devices: [],
      models: [],
      selectedDeviceId: null,
      workByDevice: {},
    })
  })
})
