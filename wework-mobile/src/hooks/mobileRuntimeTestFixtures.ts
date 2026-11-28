import { vi } from 'vitest'
import type { RuntimeSessionConfig } from '@/services/backendConfig'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/runtime'

const mocks = vi.hoisted(() => ({
  cloudConnection: { connected: true, error: null as Error | null },
  disconnected: { connected: false, error: null as Error | null },
  cloudListeners: new Set<() => void>(),
  reconnectCloud: vi.fn(async () => {}),
  order: [] as string[],
  homeDirectory: vi.fn(),
  createDirectory: vi.fn(),
  create: vi.fn(),
  devices: vi.fn(),
  models: vi.fn(),
  nativeModels: vi.fn(),
  listWork: vi.fn(),
  transcript: vi.fn(),
  preflight: vi.fn(),
  streamCreated: vi.fn(),
  updateAccessToken: vi.fn(),
  writeCache: vi.fn(),
  lifecycleSubscribe: vi.fn(),
  conversationSubscribe: vi.fn(),
  subscribeReady: vi.fn(),
  setGoal: vi.fn(),
  sendMessage: vi.fn(),
  cachedDevices: [] as DeviceInfo[],
  streamInventory: vi.fn(),
  appListeners: new Set<(state: string) => void>(),
}))
export { mocks }
export const emptyWork = { projects: [], chats: [], totalTasks: 0 }
vi.mock('expo-crypto', () => ({ randomUUID: () => 'user-message-id' }))
vi.mock('@/services/phoneLocalProfile', () => ({
  PHONE_LOCAL_USER: { id: 0, user_name: 'local', email: 'local@wework.local' },
}))
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_: string, listener: (state: string) => void) => {
      mocks.appListeners.add(listener)
      return { remove: () => mocks.appListeners.delete(listener) }
    },
  },
}))
vi.mock('@/services/runtimePermissionPreference', () => ({
  DEFAULT_RUNTIME_PERMISSION_MODE: 'full-access',
  loadRuntimePermissionMode: async () => 'full-access',
  saveRuntimePermissionMode: async () => undefined,
}))
vi.mock('@/services/runtimeCache', () => ({
  MobileRuntimeCache: class {
    async read() {
      return {
        devices: mocks.cachedDevices,
        models: [],
        selectedDeviceId: null,
        allDevicesSelected: false,
        workByDevice: {},
      }
    }
    write = mocks.writeCache
  },
}))
vi.mock('@/services/runtimeApi', () => ({
  RuntimeApi: class {
    updateBackend() {}
    clearPluginCatalogs() {}
    listDevices = mocks.devices
    listModels = mocks.models
    listNativeModels = mocks.nativeModels
    preflightWorkspace = mocks.preflight
    createConversation = mocks.create
    setGoal = mocks.setGoal
    getHomeDirectory = mocks.homeDirectory
    createDirectory = mocks.createDirectory
    sendMessage = mocks.sendMessage
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
    constructor(_config: unknown, getDevices: () => DeviceInfo[]) {
      mocks.streamCreated()
      mocks.streamInventory(getDevices)
    }
    updateBackend(config: RuntimeSessionConfig | null) {
      this.enabled = Boolean(config)
      mocks.cloudListeners.forEach(listener => listener())
      mocks.updateAccessToken(config?.accessToken ?? '')
    }
    listWork = mocks.listWork
    getTranscript = mocks.transcript
    async subscribe(scope: unknown, listener: unknown) {
      mocks.order.push('subscribe')
      mocks.conversationSubscribe(scope, listener)
      await mocks.subscribeReady()
      return () => undefined
    }
    subscribeLifecycle(listener: unknown, reconnect: unknown) {
      mocks.lifecycleSubscribe(listener, reconnect)
      return () => undefined
    }
    dispose() {}
  },
}))

export const config = {
  backendUrl: 'http://backend',
  apiBaseUrl: 'http://backend/api',
  socketBaseUrl: 'http://backend',
  socketPath: '/socket.io',
  accessToken: 'test-token',
}
export const computer: DeviceInfo = {
  id: 11,
  device_id: 'computer-name',
  execution_target_id: 'app-record-11',
  name: 'My only computer',
  device_type: 'app',
  bind_shell: 'claudecode',
  status: 'online',
  runtime_features: {
    schemaVersion: 4,
    remoteTaskAccess: { version: 1, enabled: true, taskCreation: true },
  },
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
export const workFor = (deviceId: string): RuntimeWorkListResponse => ({
  projects: [],
  totalTasks: 1,
  chats: [
    {
      deviceId,
      deviceName: deviceId,
      deviceStatus: 'online',
      available: true,
      workspacePath: '/work',
      tasks: [
        {
          taskId: 'task',
          title: deviceId,
          runtime: 'codex',
          workspacePath: '/work',
          modelSelection: { modelName: 'public-model', modelType: 'public', options: {} },
        },
      ],
    },
  ],
})

export function resetMobileRuntimeMocks() {
  mocks.cloudConnection = { connected: true, error: null }
  mocks.cloudListeners.clear()
  mocks.reconnectCloud.mockReset().mockResolvedValue(undefined)
  mocks.cachedDevices = []
  mocks.appListeners.clear()
  mocks.order.length = 0
  mocks.devices.mockReset().mockResolvedValue({ items: [computer] })
  mocks.models
    .mockReset()
    .mockResolvedValue({ data: [{ name: 'public-model', type: 'public', provider: 'cloud' }] })
  mocks.nativeModels.mockReset().mockResolvedValue({ models: [] })
  mocks.listWork.mockReset().mockResolvedValue(emptyWork)
  mocks.transcript.mockReset().mockResolvedValue({ taskId: 'task', messages: [] })
  mocks.preflight.mockReset().mockResolvedValue({ gitRepository: true, gitRef: 'main' })
  mocks.streamCreated.mockClear()
  mocks.streamInventory.mockClear()
  mocks.updateAccessToken.mockClear()
  mocks.writeCache.mockReset().mockResolvedValue(undefined)
  mocks.lifecycleSubscribe.mockClear()
  mocks.conversationSubscribe.mockClear()
  mocks.subscribeReady.mockReset().mockResolvedValue(undefined)
  mocks.setGoal.mockReset().mockResolvedValue({ accepted: true })
  mocks.sendMessage.mockReset().mockResolvedValue({ accepted: true })
  mocks.homeDirectory.mockReset().mockImplementation(async () => {
    mocks.order.push('home_dir')
    return '/Users/owner'
  })
  mocks.createDirectory.mockReset().mockImplementation(async () => {
    mocks.order.push('mkdir_p')
  })
  mocks.create.mockReset().mockImplementation(async (payload: Record<string, unknown>) => {
    mocks.order.push('create')
    return {
      accepted: true,
      taskId: payload.taskId,
      workspacePath: payload.workspacePath ?? '/Users/owner/Documents/Codex/task',
    }
  })
}
