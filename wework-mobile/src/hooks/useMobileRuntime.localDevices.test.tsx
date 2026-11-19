import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mobileCreatableDevices } from '@/domain/deviceOrdering'
import {
  LocalRuntime,
  type LocalRuntimeStatus,
  type NativeLocalRuntime,
} from '@/services/localRuntime'
import { LocalRuntimeApi } from '@/services/localRuntimeApi'
import { RuntimeApi } from '@/services/runtimeApi'
import type { RuntimeSessionConfig } from '@/services/backendConfig'
import type { RuntimeCacheSnapshot } from '@/services/runtimeCache'
import type { DeviceInfo, RuntimeDeviceWorkspace, RuntimeWorkListResponse } from '@/types/runtime'
import { useMobileRuntime, type MobileRuntimeState } from './useMobileRuntime'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  cloudConnection: { connected: true, error: null as Error | null },
  disconnected: { connected: false, error: null as Error | null },
  cloudListeners: new Set<() => void>(),
  reconnectCloud: vi.fn(async () => {}),
  readCache: vi.fn(),
  writeCache: vi.fn(),
  readLocalCache: vi.fn(),
  writeLocalCache: vi.fn(),
  devices: vi.fn(),
  listWork: vi.fn(),
  unsubscribe: vi.fn(),
  send: vi.fn(),
}))
vi.mock('expo-crypto', () => ({ randomUUID: () => 'local-device-test-message' }))
vi.mock('@/services/phoneLocalProfile', () => ({
  PHONE_LOCAL_USER: { id: 0, user_name: 'local', email: 'local@wework.local' },
}))
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: vi.fn() }) },
}))
vi.mock('@/services/runtimePermissionPreference', () => ({
  DEFAULT_RUNTIME_PERMISSION_MODE: 'full-access',
  loadRuntimePermissionMode: async () => 'full-access',
  saveRuntimePermissionMode: async () => undefined,
}))
vi.mock('@/services/runtimeCache', () => ({
  MobileRuntimeCache: class {
    static local() {
      return { read: mocks.readLocalCache, write: mocks.writeLocalCache }
    }
    read = mocks.readCache
    write = mocks.writeCache
  },
}))
vi.mock('@/services/runtimeStream', () => ({
  RuntimeStream: class {
    enabled = true
    getCloudConnection = () => (this.enabled ? mocks.cloudConnection : mocks.disconnected)
    subscribeCloudConnection = (listener: () => void) => {
      mocks.cloudListeners.add(listener)
      return () => mocks.cloudListeners.delete(listener)
    }
    reconnectCloud = mocks.reconnectCloud
    updateAccessToken() {}
    constructor(config: RuntimeSessionConfig | null) {
      this.enabled = Boolean(config)
    }
    updateBackend(config: RuntimeSessionConfig | null) {
      this.enabled = Boolean(config)
      mocks.cloudListeners.forEach(listener => listener())
    }
    listWork = mocks.listWork
    async getTranscript(address: { taskId: string }) {
      return { taskId: address.taskId, running: false, messages: [] }
    }
    async subscribe() {
      return mocks.unsubscribe
    }
    subscribeLifecycle() {
      return () => undefined
    }
    dispose() {}
  },
}))

const config = {
  backendUrl: 'https://wegent.test',
  apiBaseUrl: 'https://wegent.test/api',
  socketBaseUrl: 'https://wegent.test',
  socketPath: '/socket.io',
  accessToken: 'test-token',
}
const user = { id: 7, user_name: 'local-device-test' }
const scope = 'a'.repeat(64)
const phoneId = `mobile-local:phone:${scope}`
const cloud: DeviceInfo = {
  id: 2,
  device_id: 'cloud-device',
  name: 'Cloud',
  device_type: 'cloud',
  bind_shell: 'claudecode',
  status: 'online',
}
const emptyWork: RuntimeWorkListResponse = { projects: [], chats: [], totalTasks: 0 }
const cloudWork: RuntimeWorkListResponse = {
  projects: [],
  totalTasks: 1,
  chats: [
    {
      deviceId: cloud.device_id,
      deviceName: cloud.name,
      deviceStatus: 'online',
      available: true,
      workspacePath: '/cloud/work',
      tasks: [
        {
          taskId: 'cloud-task',
          title: 'Cloud task',
          runtime: 'codex',
          workspacePath: '/cloud/work',
          runtimeHandle: {
            modelSelection: { modelName: 'public-model', modelType: 'public', options: {} },
          },
        },
      ],
    },
  ],
}
const emptyCache: RuntimeCacheSnapshot = {
  allDevicesSelected: false,
  devices: [],
  models: [],
  selectedDeviceId: null,
  workByDevice: {},
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function nativeFixture() {
  let status: LocalRuntimeStatus = {
    supported: true,
    state: 'stopped',
    generation: 1,
    accountScope: scope,
    deviceId: phoneId,
    background: 'notRequested',
  }
  const listeners = new Map<string, (value: never) => void>()
  const native = {
    getStatusAsync: vi.fn(async () => status),
    startAsync: vi.fn(async () => status),
    stopAsync: vi.fn(async () => undefined),
    importFileAsync: vi.fn(),
    requestAsync: vi.fn<NativeLocalRuntime['requestAsync']>(async input => ({
      type: 'response',
      id: 'native-test',
      ok: true,
      result:
        input.method === 'runtime.runner.catalog'
          ? { models: [], errors: [] }
          : input.method === 'runtime.worktrees.preflight'
            ? { gitRepository: false }
            : { activeAccountId: null, accounts: [] },
    })),
    getEventsAsync: vi.fn(async () => ({ events: [], latestSequence: 0 })),
    addListener: vi.fn((name: string, listener: (value: never) => void) => {
      listeners.set(name, listener)
      return { remove: () => listeners.delete(name) }
    }),
  }
  const runtime = new LocalRuntime(native as unknown as NativeLocalRuntime, scope)
  return {
    runtime,
    native,
    publish(state: LocalRuntimeStatus['state']) {
      status = { ...status, state }
      listeners.get('onRuntimeStatus')?.(status as never)
    },
  }
}

// PC references: localServices.runtimeReadiness.test.ts (native readiness),
// api/devices.test.ts (device routing), useRuntimeTaskRouteRestoration.test.tsx (task ownership).
describe('native phone device inventory publication', () => {
  let fixture: ReturnType<typeof nativeFixture>
  let state: MobileRuntimeState
  let renderer: ReactTestRenderer | undefined
  function Harness({
    session = config,
    backendUserId = user.id,
  }: {
    session?: RuntimeSessionConfig | null
    backendUserId?: number
  }) {
    state = useMobileRuntime(session, backendUserId, { runtime: fixture.runtime })
    return null
  }
  const phone = () => state.devices.find(device => device.device_id === phoneId)
  async function mount(session: RuntimeSessionConfig | null = config) {
    await act(async () => {
      renderer = create(<Harness session={session} />)
    })
  }
  async function publish(next: LocalRuntimeStatus['state']) {
    await act(async () => {
      fixture.publish(next)
    })
  }

  beforeEach(async () => {
    mocks.cloudConnection = { connected: true, error: null }
    mocks.cloudListeners.clear()
    fixture = nativeFixture()
    await fixture.runtime.initialize()
    mocks.readCache.mockReset().mockResolvedValue(emptyCache)
    mocks.writeCache.mockReset().mockResolvedValue(undefined)
    mocks.readLocalCache.mockReset().mockResolvedValue(emptyCache)
    mocks.writeLocalCache.mockReset().mockResolvedValue(undefined)
    mocks.devices
      .mockReset()
      .mockImplementation(async () => new Response(JSON.stringify({ items: [cloud] })))
    mocks.listWork
      .mockReset()
      .mockImplementation(async (deviceId: string) =>
        deviceId === cloud.device_id ? cloudWork : emptyWork
      )
    mocks.unsubscribe.mockClear()
    mocks.send.mockReset().mockResolvedValue({ accepted: true, taskId: 'cloud-task' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.endsWith('/devices')) return mocks.devices()
        if (input.includes('/models/unified'))
          return new Response(
            JSON.stringify({ data: [{ name: 'public-model', type: 'public', provider: 'cloud' }] })
          )
        if (input.endsWith('/runtime-work/send'))
          return new Response(JSON.stringify(await mocks.send(JSON.parse(String(init?.body)))))
        throw new Error(`Unexpected Backend request: ${input}`)
      })
    )
  })
  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount())
    renderer = undefined
    fixture.runtime.dispose()
    vi.unstubAllGlobals()
  })

  it('reads native readiness after an in-flight Backend device response', async () => {
    fixture.publish('starting')
    const pending = deferred<Response>()
    mocks.devices.mockReturnValueOnce(pending.promise)
    const api = new RuntimeApi(
      config,
      undefined,
      undefined,
      undefined,
      new LocalRuntimeApi(fixture.runtime, config, () => config.accessToken, user)
    )
    const response = api.listDevices()
    fixture.publish('running')
    pending.resolve(new Response(JSON.stringify({ items: [cloud] })))
    expect((await response).items.find(device => device.device_id === phoneId)?.status).toBe(
      'online'
    )
  })

  it('does not overwrite stored cloud preferences before the first cache read finishes', async () => {
    const gate = deferred<void>()
    let stored: RuntimeCacheSnapshot = {
      ...emptyCache,
      devices: [cloud],
      selectedDeviceId: cloud.device_id,
      workByDevice: { [cloud.device_id]: cloudWork },
    }
    mocks.readCache.mockImplementationOnce(async () => {
      await gate.promise
      return stored
    })
    mocks.writeCache.mockImplementation(async (value: RuntimeCacheSnapshot) => {
      stored = value
    })
    await mount()
    await publish('running')
    expect(mocks.writeCache).not.toHaveBeenCalled()
    expect(stored.selectedDeviceId).toBe(cloud.device_id)
    await act(async () => gate.resolve())
    expect(state.selectedDeviceId).toBe(cloud.device_id)
    expect(stored.workByDevice[cloud.device_id]).toEqual(cloudWork)
  })

  it('keeps discovery usable after a cache read failure without overwriting the unread data', async () => {
    mocks.readCache.mockRejectedValueOnce(new Error('cache unavailable'))
    await mount()
    expect(state.devices.some(device => device.device_id === cloud.device_id)).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBe('cache unavailable')
    expect(mocks.writeCache).not.toHaveBeenCalled()
  })

  it('hydrates the destination account before publishing any writes into its cache', async () => {
    await mount()
    const gate = deferred<void>()
    const discovery = deferred<Response>()
    let stored: RuntimeCacheSnapshot = {
      ...emptyCache,
      devices: [cloud],
      selectedDeviceId: cloud.device_id,
      workByDevice: { [cloud.device_id]: cloudWork },
    }
    mocks.readCache.mockImplementationOnce(async () => {
      await gate.promise
      return stored
    })
    mocks.writeCache.mockClear().mockImplementation(async (value: RuntimeCacheSnapshot) => {
      stored = value
    })
    mocks.devices.mockReturnValueOnce(discovery.promise)
    await act(async () => renderer?.update(<Harness backendUserId={8} />))
    expect(mocks.writeCache).not.toHaveBeenCalled()
    expect(stored.selectedDeviceId).toBe(cloud.device_id)
    await act(async () => gate.resolve())
    expect(stored.workByDevice[cloud.device_id]).toEqual(cloudWork)
    expect(stored.devices.some(row => row.device_id === cloud.device_id)).toBe(true)
    await act(async () => discovery.resolve(new Response(JSON.stringify({ items: [cloud] }))))
  })

  it('retains the running transition when another refresh and settings refresh overlap', async () => {
    await mount()
    const pending = deferred<Response>()
    mocks.devices.mockReturnValueOnce(pending.promise)
    let refresh!: Promise<void>
    await act(async () => {
      refresh = state.refresh()
    })
    await publish('starting')
    await publish('running')
    let settingsRefresh!: Promise<void>
    await act(async () => {
      settingsRefresh = state.refresh()
    })
    expect(phone()?.status).toBe('online')
    await act(async () => {
      pending.resolve(new Response(JSON.stringify({ items: [cloud] })))
      await Promise.all([refresh, settingsRefresh])
    })
    expect(phone()?.status).toBe('online')
  })

  it('keeps current readiness when the initial Backend response arrives last', async () => {
    const initial = deferred<Response>()
    mocks.devices.mockReturnValueOnce(initial.promise)
    await mount()
    await publish('running')
    expect(phone()?.status).toBe('online')
    await act(async () => {
      initial.resolve(new Response(JSON.stringify({ items: [cloud] })))
    })
    expect(phone()?.status).toBe('online')
  })

  it.each(['network rejection', 'HTTP failure'])(
    'keeps the running phone selectable and exposes the remote error after %s',
    async failure => {
      fixture.publish('running')
      if (failure === 'network rejection') {
        mocks.devices.mockRejectedValueOnce(new Error('Device discovery unavailable'))
      } else {
        mocks.devices.mockResolvedValueOnce(
          new Response(JSON.stringify({ detail: 'Device discovery unavailable' }), {
            status: 503,
          })
        )
      }
      await mount()
      expect(mobileCreatableDevices(state.devices).map(device => device.device_id)).toEqual([
        phoneId,
      ])
      expect(state.selectedDeviceId).toBe(phoneId)
      expect(state.error).toBeNull()
      expect(state.connectionError).toBe('远程设备不可用：Device discovery unavailable')
      expect(mocks.listWork).toHaveBeenCalledWith(phoneId, '这台手机')
    }
  )

  it('retains the latest remote inventory when the initial Backend snapshot resolves last', async () => {
    const initial = deferred<Response>()
    const updatedCloud = { ...cloud, name: 'Updated cloud name' }
    const newCloud = { ...cloud, id: 3, device_id: 'new-cloud', name: 'New cloud' }
    mocks.devices
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [updatedCloud, newCloud] })))
    await mount()
    await publish('running')
    await act(async () => {
      await state.refreshDevices()
    })
    expect(mocks.devices).toHaveBeenCalledTimes(2)
    expect(state.devices.filter(device => device.device_type === 'cloud')).toEqual([
      updatedCloud,
      newCloud,
    ])
    await act(async () => {
      initial.resolve(new Response(JSON.stringify({ items: [cloud] })))
    })
    expect(phone()?.status).toBe('online')
    expect(state.devices.filter(device => device.device_type === 'cloud')).toEqual([
      updatedCloud,
      newCloud,
    ])
  })

  it('makes the running phone selectable before a slow Backend completes', async () => {
    const pending = deferred<Response>()
    mocks.devices.mockReturnValue(pending.promise)
    await mount()
    await publish('running')
    expect(mobileCreatableDevices(state.devices).map(device => device.device_id)).toContain(phoneId)
    await act(async () => {
      state.selectDevice(phoneId)
    })
    expect(state.selectedDeviceId).toBe(phoneId)
    expect(mocks.listWork).toHaveBeenCalledWith(phoneId, '这台手机')
    await act(async () => {
      pending.resolve(new Response(JSON.stringify({ items: [cloud] })))
    })
    expect(state.selectedDeviceId).toBe(phoneId)
  })

  it('shows a resolved phone list while initial Backend discovery remains pending', async () => {
    const backend = deferred<Response>()
    mocks.devices.mockReturnValue(backend.promise)
    const work = { ...cloudWork, chats: [{ ...cloudWork.chats[0]!, deviceId: phoneId }] }
    mocks.listWork.mockImplementation(async (id: string) => (id === phoneId ? work : cloudWork))
    await mount()
    await publish('running')
    expect(state.selectedDeviceId).toBe(phoneId)
    expect(state.work).toEqual(work)
    expect(state.loading).toBe(false)
    await act(async () => backend.resolve(new Response(JSON.stringify({ items: [cloud] }))))
    expect(mocks.listWork.mock.calls.filter(([id]) => id === phoneId)).toHaveLength(1)
  })

  it('loads an already-running phone without waiting for cloud discovery', async () => {
    const backend = deferred<Response>()
    mocks.devices.mockReturnValue(backend.promise)
    fixture.publish('running')
    await mount()
    expect(mocks.listWork).toHaveBeenCalledWith(phoneId, '这台手机')
    expect(state.loading).toBe(false)
    await act(async () => backend.resolve(new Response(JSON.stringify({ items: [cloud] }))))
    expect(mocks.listWork.mock.calls.filter(([id]) => id === phoneId)).toHaveLength(1)
  })

  it('shows the stored phone snapshot immediately while its fresh read is pending', async () => {
    const backend = deferred<Response>()
    const pending = deferred<RuntimeWorkListResponse>()
    mocks.devices.mockReturnValue(backend.promise)
    mocks.readLocalCache.mockResolvedValue({
      ...emptyCache,
      devices: [fixture.runtime.device()!],
      selectedDeviceId: phoneId,
      workByDevice: { [phoneId]: emptyWork },
    })
    mocks.listWork.mockImplementation((id: string) =>
      id === phoneId ? pending.promise : Promise.resolve(cloudWork)
    )
    await mount()
    await publish('running')
    expect(state.selectedDeviceId).toBe(phoneId)
    expect(state.work).toEqual(emptyWork)
    expect(state.loading).toBe(false)
    await act(async () => pending.resolve(emptyWork))
    await act(async () => backend.resolve(new Response(JSON.stringify({ items: [cloud] }))))
  })

  it('does not restore the spinner when a late cache snapshot follows a fresh local result', async () => {
    const cache = deferred<RuntimeCacheSnapshot>()
    const backend = deferred<Response>()
    mocks.readLocalCache.mockReturnValue(cache.promise)
    mocks.devices.mockReturnValue(backend.promise)
    await mount()
    await publish('running')
    expect(state.loading).toBe(false)
    await act(async () => cache.resolve(emptyCache))
    expect(state.loading).toBe(false)
    expect(state.selectedDeviceId).toBe(phoneId)
    await act(async () => backend.resolve(new Response(JSON.stringify({ items: [cloud] }))))
  })

  it('keeps fresh phone conversations visible when an older empty cache arrives last', async () => {
    const cache = deferred<RuntimeCacheSnapshot>()
    const backend = deferred<Response>()
    const fresh = { ...cloudWork, chats: [{ ...cloudWork.chats[0]!, deviceId: phoneId }] }
    mocks.readLocalCache.mockReturnValue(cache.promise)
    mocks.devices.mockReturnValue(backend.promise)
    mocks.listWork.mockImplementation(async (id: string) => (id === phoneId ? fresh : cloudWork))
    await mount()
    await publish('running')
    expect(state.work).toEqual(fresh)
    await act(async () =>
      cache.resolve({
        ...emptyCache,
        devices: [fixture.runtime.device()!],
        selectedDeviceId: phoneId,
        workByDevice: { [phoneId]: emptyWork },
      })
    )
    expect(state.work).toEqual(fresh)
    expect(state.conversations).toHaveLength(1)
    expect(state.loading).toBe(false)
    await act(async () => backend.resolve(new Response(JSON.stringify({ items: [cloud] }))))
    expect(state.work).toEqual(fresh)
    expect(mocks.listWork.mock.calls.filter(([id]) => id === phoneId)).toHaveLength(1)
  })

  it('settles a failed initial phone read without waiting for cloud or retrying on readiness', async () => {
    const backend = deferred<Response>()
    mocks.devices.mockReturnValue(backend.promise)
    mocks.listWork.mockRejectedValue(new Error('local list unavailable'))
    await mount()
    await publish('running')
    expect(state.loading).toBe(false)
    expect(state.connectionError).toBe('local list unavailable')
    expect(state.error).toBeNull()
    await publish('stopped')
    await publish('running')
    expect(mocks.listWork.mock.calls.filter(([id]) => id === phoneId)).toHaveLength(1)
    await act(async () => backend.resolve(new Response(JSON.stringify({ items: [cloud] }))))
  })

  it('does not start a duplicate local read when discovery finishes before the first read', async () => {
    const backend = deferred<Response>()
    const pending = deferred<RuntimeWorkListResponse>()
    mocks.devices.mockReturnValue(backend.promise)
    mocks.listWork.mockImplementation((id: string) =>
      id === phoneId ? pending.promise : Promise.resolve(cloudWork)
    )
    await mount()
    await publish('running')
    await act(async () => backend.resolve(new Response(JSON.stringify({ items: [cloud] }))))
    expect(state.loading).toBe(true)
    expect(mocks.listWork.mock.calls.filter(([id]) => id === phoneId)).toHaveLength(1)
    await act(async () => pending.resolve(emptyWork))
    expect(state.loading).toBe(false)
  })

  it('shows loading only while the first selected phone query is actually pending', async () => {
    const pending = deferred<RuntimeWorkListResponse>()
    mocks.devices.mockResolvedValue(new Response(JSON.stringify({ items: [] })))
    mocks.listWork.mockReturnValue(pending.promise)
    await mount()
    expect(state.loading).toBe(false)
    await publish('running')
    expect(state.selectedDeviceId).toBe(phoneId)
    expect(state.loading).toBe(true)
    await act(async () => pending.resolve(emptyWork))
    expect(state.loading).toBe(false)
  })

  it('does not let an older phone query settle loading after leaving and reselecting the phone', async () => {
    const pending = [
      deferred<RuntimeWorkListResponse>(),
      deferred<RuntimeWorkListResponse>(),
      deferred<RuntimeWorkListResponse>(),
    ]
    let phoneReads = 0
    mocks.listWork.mockImplementation((id: string) =>
      id === phoneId ? pending[phoneReads++]!.promise : Promise.resolve(cloudWork)
    )
    await mount()
    await publish('running')
    await act(() => state.selectDevice(phoneId))
    await act(() => state.selectDevice(cloud.device_id))
    await act(() => state.selectDevice(phoneId))
    expect(phoneReads).toBe(3)
    expect(state.loading).toBe(true)
    await act(async () => pending[1]!.resolve(emptyWork))
    expect(state.loading).toBe(true)
    await act(async () => pending[0]!.resolve(emptyWork))
    expect(state.loading).toBe(true)
    await act(async () => pending[2]!.resolve(emptyWork))
    expect(state.loading).toBe(false)
  })

  it('does not refresh an already loaded phone list on later availability transitions', async () => {
    await mount()
    await publish('running')
    expect(mocks.listWork).toHaveBeenCalledWith(phoneId, '这台手机')
    const calls = mocks.listWork.mock.calls.length
    await publish('stopped')
    await publish('running')
    expect(mocks.listWork).toHaveBeenCalledTimes(calls)
    await act(() => state.refresh())
    expect(mocks.listWork.mock.calls.length).toBeGreaterThan(calls)
  })

  it.each(['phone', 'all'] as const)(
    'refreshes phone work in the %s view while Backend discovery is unreachable',
    async selection => {
      await mount()
      await publish('running')
      if (selection === 'all') await act(() => state.selectAllDevices())
      else await act(() => state.selectDevice(phoneId))
      const discoveryCalls = mocks.devices.mock.calls.length
      mocks.cloudConnection = { connected: false, error: new Error('Company network unavailable') }
      await act(() => mocks.cloudListeners.forEach(listener => listener()))
      const fresh = { ...cloudWork, chats: [{ ...cloudWork.chats[0]!, deviceId: phoneId }] }
      mocks.listWork.mockImplementation(async (id: string) => (id === phoneId ? fresh : cloudWork))
      const before = mocks.listWork.mock.calls.filter(([id]) => id === phoneId).length
      let refresh!: Promise<void>
      await act(async () => {
        refresh = state.refresh()
      })
      expect(mocks.listWork.mock.calls.filter(([id]) => id === phoneId)).toHaveLength(before + 1)
      expect(state.work.chats.some(chat => chat.deviceId === phoneId)).toBe(true)
      expect(state.loading).toBe(false)
      await act(async () => {
        await refresh
      })
      expect(mocks.listWork.mock.calls.filter(([id]) => id === phoneId)).toHaveLength(before + 1)
      expect(state.work.chats.some(chat => chat.deviceId === phoneId)).toBe(true)
      expect(state.error).toBeNull()
      expect(state.connectionError).toContain('Company network unavailable')
      expect(state.refreshing).toBe(false)
      expect(mocks.devices).toHaveBeenCalledTimes(discoveryCalls)
      expect(state.devices.map(device => device.device_id)).toEqual([phoneId])
    }
  )

  it.each(['cloud', 'all'] as const)(
    'does not block phone refresh behind a pending %s list refresh',
    async view => {
      await mount()
      await publish('running')
      await act(() =>
        view === 'cloud' ? state.selectDevice(cloud.device_id) : state.selectAllDevices()
      )
      const remote = deferred<RuntimeWorkListResponse>()
      mocks.listWork.mockImplementation((id: string) =>
        id === cloud.device_id ? remote.promise : Promise.resolve(emptyWork)
      )
      let remoteRefresh!: Promise<void>
      await act(() => {
        remoteRefresh = state.refresh()
      })
      expect(state.refreshing).toBe(true)
      await act(() => state.selectDevice(phoneId))
      expect(state.refreshing).toBe(false)
      const before = mocks.listWork.mock.calls.filter(([id]) => id === phoneId).length
      await act(() => state.refresh())
      expect(mocks.listWork.mock.calls.filter(([id]) => id === phoneId)).toHaveLength(before + 1)
      expect(state.refreshing).toBe(false)
      await act(async () => {
        remote.resolve(cloudWork)
        await remoteRefresh
      })
      expect(state.selectedDeviceId).toBe(phoneId)
      expect(state.work).toEqual(emptyWork)
    }
  )

  it('keeps the phone usable when cloud connectivity disappears from a selected remote list', async () => {
    await mount()
    await publish('running')
    await act(() => state.selectDevice(cloud.device_id))
    expect(state.selectedDeviceId).toBe(cloud.device_id)
    const reads = mocks.listWork.mock.calls.length
    await act(() => {
      mocks.cloudConnection = { connected: false, error: new Error('offline') }
      mocks.cloudListeners.forEach(listener => listener())
    })
    expect(state.devices.map(device => device.device_id)).toEqual([phoneId])
    expect(state.selectedDeviceId).toBe(phoneId)
    expect(state.loading).toBe(false)
    expect(mocks.listWork).toHaveBeenCalledTimes(reads)
    await act(() => {
      mocks.cloudConnection = { connected: true, error: null }
      mocks.cloudListeners.forEach(listener => listener())
    })
    expect(state.selectedDeviceId).toBe(phoneId)
    expect(mocks.listWork).toHaveBeenCalledTimes(reads)
    expect(mocks.devices).toHaveBeenCalledOnce()
  })

  it('does not resurrect an online phone from a response that started before stopping', async () => {
    await mount()
    await publish('running')
    const pending = deferred<Response>()
    mocks.devices.mockReturnValueOnce(pending.promise)
    let refresh!: Promise<void>
    await act(async () => {
      refresh = state.refresh()
    })
    await publish('stopping')
    expect(mobileCreatableDevices(state.devices).map(device => device.device_id)).not.toContain(
      phoneId
    )
    await act(async () => {
      pending.resolve(new Response(JSON.stringify({ items: [cloud] })))
      await refresh
    })
    expect(phone()?.status).toBe('offline')
  })

  it('projects current readiness over a late cache restore', async () => {
    const cached = deferred<RuntimeCacheSnapshot>()
    const backend = deferred<Response>()
    mocks.readCache.mockReturnValueOnce(cached.promise)
    mocks.devices.mockReturnValue(backend.promise)
    await mount()
    await publish('running')
    await act(async () => {
      cached.resolve({ ...emptyCache, devices: [cloud] })
    })
    expect(phone()?.status).toBe('online')
    await act(async () => {
      backend.resolve(new Response(JSON.stringify({ items: [cloud] })))
    })
    expect(phone()?.status).toBe('online')
  })

  it.each(['device', 'workspace', 'new conversation'])(
    'keeps an explicit %s selection made before the cached cloud preference arrives',
    async selection => {
      const cached = deferred<RuntimeCacheSnapshot>()
      const backend = deferred<Response>()
      mocks.readCache.mockReturnValueOnce(cached.promise)
      const workspace: RuntimeDeviceWorkspace = {
        deviceId: phoneId,
        deviceName: '这台手机',
        deviceStatus: 'online',
        available: true,
        workspacePath: '/root/selected-project',
        tasks: [],
      }
      await mount()
      await publish('running')
      expect(state.selectedDeviceId).toBe(phoneId)
      await act(async () => {
        if (selection === 'device') state.selectDevice(phoneId)
        else if (selection === 'workspace') state.selectWorkspace(workspace)
        else state.startNewConversation(workspace)
      })
      await act(async () => {
        cached.resolve({ ...emptyCache, devices: [cloud], selectedDeviceId: cloud.device_id })
      })
      expect(state.selectedDeviceId).toBe(phoneId)
      expect(state.selectedWorkspace).toEqual(selection === 'device' ? null : workspace)
      await act(async () => {
        backend.resolve(new Response(JSON.stringify({ items: [cloud] })))
      })
      expect(state.selectedDeviceId).toBe(phoneId)
      expect(state.selectedWorkspace).toEqual(selection === 'device' ? null : workspace)
    }
  )

  it('restores the cached cloud preference after automatic native publication without user selection', async () => {
    const cached = deferred<RuntimeCacheSnapshot>()
    const backend = deferred<Response>()
    mocks.readCache.mockReturnValueOnce(cached.promise)
    mocks.devices.mockReturnValueOnce(backend.promise)
    await mount()
    await publish('running')
    expect(state.selectedDeviceId).toBe(phoneId)
    await act(async () => {
      cached.resolve({ ...emptyCache, devices: [cloud], selectedDeviceId: cloud.device_id })
    })
    expect(state.selectedDeviceId).toBe(cloud.device_id)
    await act(async () => {
      backend.resolve(new Response(JSON.stringify({ items: [cloud] })))
    })
    expect(state.selectedDeviceId).toBe(cloud.device_id)
  })

  it('keeps an existing cloud conversation and its next message on the cloud executor', async () => {
    await mount()
    await act(async () => {
      await state.openConversation(state.conversations[0]!)
    })
    const address = state.currentAddress
    await publish('starting')
    await publish('running')
    expect(state.currentAddress).toEqual(address)
    expect(state.selectedDeviceId).toBe(cloud.device_id)
    await act(async () => {
      state.selectDevice(phoneId)
    })
    expect(state.currentAddress).toEqual(address)
    await act(async () => {
      expect(await state.send('Continue on the original executor')).toBe(true)
    })
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ address }))
    expect(
      fixture.native.requestAsync.mock.calls.some(
        ([input]) => input.method === 'runtime.tasks.send'
      )
    ).toBe(false)
  })

  it.each(
    [
      { transition: 'connect', previous: null, next: config, nextUserId: user.id },
      { transition: 'disconnect', previous: config, next: null, nextUserId: user.id },
      {
        transition: 'switch account',
        previous: config,
        next: { ...config, accessToken: 'other-account-token' },
        nextUserId: 8,
      },
    ].flatMap(transition => [false, true].map(existingTask => ({ ...transition, existingTask })))
  )(
    'preserves the phone workspace across Backend $transition, existingTask=$existingTask',
    async ({ previous, next, nextUserId, existingTask }) => {
      fixture.publish('running')
      const workspace: RuntimeDeviceWorkspace = {
        deviceId: phoneId,
        deviceName: '这台手机',
        deviceStatus: 'online',
        available: true,
        workspacePath: '/root/current-project',
        tasks: [
          {
            taskId: 'phone-task',
            title: 'Phone task',
            runtime: 'codex',
            workspacePath: '/root/current-project',
          },
        ],
      }
      mocks.listWork.mockImplementation(async (deviceId: string) =>
        deviceId === phoneId ? { projects: [], chats: [workspace], totalTasks: 1 } : cloudWork
      )
      await mount(previous)
      await act(async () => {
        if (existingTask) {
          await state.openConversation(
            state.conversations.find(item => item.address.deviceId === phoneId)!
          )
        } else state.startNewConversation(workspace)
      })
      const address = state.currentAddress
      const unsubscribeCalls = mocks.unsubscribe.mock.calls.length
      const api = state.api
      expect(state.selectedWorkspace).toEqual(workspace)
      await act(async () => {
        renderer!.update(<Harness session={next} backendUserId={nextUserId} />)
      })
      expect(state.api).toBe(api)
      expect(state.selectedDeviceId).toBe(phoneId)
      expect(state.selectedWorkspace).toEqual(workspace)
      expect(state.currentAddress).toEqual(address)
      expect(phone()?.status).toBe('online')
      expect(mocks.unsubscribe).toHaveBeenCalledTimes(unsubscribeCalls)
      expect(fixture.native.stopAsync).not.toHaveBeenCalled()
    }
  )

  it.each(['Backend', 'cache'])(
    'filters unsupported and untrusted %s devices before selection and work reads',
    async source => {
      fixture.publish('running')
      const unsupported: DeviceInfo[] = [
        { ...cloud, id: 3, device_id: 'unsupported-shell', bind_shell: 'openclaw' },
        {
          ...cloud,
          id: 4,
          device_id: 'opted-out-app',
          device_type: 'app',
          execution_target_id: 'app-record-4',
          runtime_features: {
            schemaVersion: 4,
            remoteTaskAccess: { version: 1, enabled: false, taskCreation: true },
          },
        },
        {
          ...cloud,
          id: 5,
          device_id: 'mobile-local:spoofed-phone',
          device_type: 'local',
          runtime_features: { schemaVersion: 1, embeddedRuntime: { version: 1 } },
        },
      ]
      const inventory = [cloud, ...unsupported]
      const workByDevice = Object.fromEntries(
        [fixture.runtime.device()!, ...inventory].map(device => {
          const deviceId = device.execution_target_id ?? device.device_id
          return [
            deviceId,
            {
              projects: [],
              totalTasks: 1,
              chats: [
                {
                  ...cloudWork.chats[0]!,
                  deviceId,
                  tasks: [
                    {
                      taskId: `task-${deviceId}`,
                      title: device.name,
                      runtime: 'codex',
                      workspacePath: cloudWork.chats[0]!.workspacePath,
                    },
                  ],
                },
              ],
            } satisfies RuntimeWorkListResponse,
          ]
        })
      )
      // Backend discovery must also evict work cached while these peers were eligible.
      const cachedDevices =
        source === 'cache'
          ? inventory
          : inventory.map(device => ({
              ...device,
              bind_shell: 'claudecode' as const,
              ...(device.device_type === 'app'
                ? {
                    runtime_features: {
                      schemaVersion: 4,
                      remoteTaskAccess: { version: 1, enabled: true, taskCreation: true },
                    },
                  }
                : {}),
            }))
      mocks.readCache.mockResolvedValueOnce({
        ...emptyCache,
        devices: cachedDevices,
        workByDevice,
        selectedDeviceId: unsupported[0]!.device_id,
      })
      mocks.readLocalCache.mockResolvedValueOnce({
        ...emptyCache,
        devices: [fixture.runtime.device()!],
        workByDevice: { [phoneId]: workByDevice[phoneId]! },
      })
      const backend = deferred<Response>()
      mocks.devices.mockReturnValueOnce(
        source === 'cache'
          ? backend.promise
          : Promise.resolve(new Response(JSON.stringify({ items: inventory })))
      )
      const allowed = [phoneId, cloud.device_id]
      mocks.listWork.mockImplementation(async (deviceId: string) => {
        if (!allowed.includes(deviceId)) throw new Error(`Forbidden work read: ${deviceId}`)
        return workByDevice[deviceId]!
      })
      await mount()
      expect(state.devices.map(device => device.device_id)).toEqual(allowed)
      expect(state.selectedDeviceId).toBe(phoneId)
      await act(async () => {
        state.selectAllDevices()
      })
      expect(state.work.chats.map(workspace => workspace.deviceId).sort()).toEqual(
        [...allowed].sort()
      )
      expect(state.conversations.map(item => item.address.deviceId).sort()).toEqual(
        [...allowed].sort()
      )
      expect(state.work.totalTasks).toBe(2)
      expect(Object.keys(mocks.writeCache.mock.calls.at(-1)![0].workByDevice)).toEqual([
        cloud.device_id,
      ])
      expect(Object.keys(mocks.writeLocalCache.mock.calls.at(-1)![0].workByDevice)).toEqual([
        phoneId,
      ])
      expect(new Set(mocks.listWork.mock.calls.map(([deviceId]) => deviceId))).toEqual(
        new Set(allowed)
      )
      if (source === 'cache') {
        await act(async () => {
          backend.resolve(new Response(JSON.stringify({ items: [cloud] })))
        })
        expect(state.devices.map(device => device.device_id)).toEqual(allowed)
      }
    }
  )
})
