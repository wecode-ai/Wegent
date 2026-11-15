import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkbenchDeviceResolver } from '../../../packages/chat-core/src/runtime-device-identity'

import type { MobileRuntimeState } from './useMobileRuntime'
import { useMobileRuntime } from './useMobileRuntime'
import type { RuntimeSessionConfig } from '@/services/backendConfig'
import type { Attachment, DeviceInfo, RuntimeWorkListResponse } from '@/types/runtime'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
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
  sendMessage: vi.fn(),
  cachedDevices: [] as DeviceInfo[],
  streamInventory: vi.fn(),
}))
const emptyWork = { projects: [], chats: [], totalTasks: 0 }
vi.mock('expo-crypto', () => ({ randomUUID: () => 'user-message-id' }))
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
    clearPluginCatalogs() {}
    listDevices = mocks.devices
    listModels = mocks.models
    listNativeModels = mocks.nativeModels
    preflightWorkspace = mocks.preflight
    createConversation = mocks.create
    getHomeDirectory = mocks.homeDirectory
    createDirectory = mocks.createDirectory
    sendMessage = mocks.sendMessage
  },
}))
vi.mock('@/services/runtimeStream', () => ({
  RuntimeStream: class {
    constructor(_config: unknown, getDevices: () => DeviceInfo[]) {
      mocks.streamCreated()
      mocks.streamInventory(getDevices)
    }
    updateAccessToken = mocks.updateAccessToken
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

const config = {
  backendUrl: 'http://backend',
  apiBaseUrl: 'http://backend/api',
  socketBaseUrl: 'http://backend',
  socketPath: '/socket.io',
  accessToken: 'test-token',
}
const computer: DeviceInfo = {
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
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const workFor = (deviceId: string): RuntimeWorkListResponse => ({
  projects: [],
  totalTasks: 1,
  chats: [
    {
      deviceId,
      deviceName: deviceId,
      deviceStatus: 'online',
      available: true,
      workspacePath: '/work',
      tasks: [{ taskId: 'task', title: deviceId, runtime: 'codex', workspacePath: '/work' }],
    },
  ],
})

describe('creating a conversation on the only computer', () => {
  let renderer: ReactTestRenderer
  let state: MobileRuntimeState
  function Harness({ session = config }: { session?: RuntimeSessionConfig }) {
    state = useMobileRuntime(session, 7)
    return null
  }

  beforeEach(() => {
    mocks.cachedDevices = []
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
  })
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
  })

  async function mount() {
    await act(async () => {
      renderer = create(<Harness />)
    })
    expect(state.selectedDeviceId).toBe('app-record-11')
    expect(state.selectedModel?.name).toBe('public-model')
    await act(() => state.startNewConversation())
  }

  it.each(['new', 'existing'] as const)(
    'keeps complete %s message attachments through sending, confirmation and transcript reload',
    async kind => {
      const attachment: Attachment = {
        id: 42,
        filename: 'report.pdf',
        file_size: 150,
        mime_type: 'application/pdf',
        status: 'ready',
        file_extension: 'pdf',
        created_at: '2026-11-14T10:00:00Z',
        workspace_file: {
          device_id: 'storage-device',
          workspace_path: '/project',
          path: 'report.pdf',
        },
        ui_group_id: 'files',
        ui_group_role: 'primary',
      }
      mocks.listWork.mockResolvedValue(workFor('app-record-11'))
      await mount()
      if (kind === 'existing') await act(() => state.openConversation(state.conversations[0]!))
      const response = deferred<{ accepted: boolean; taskId: string; workspacePath: string }>()
      const operation = kind === 'new' ? mocks.create : mocks.sendMessage
      operation.mockReturnValue(response.promise)
      let send!: Promise<boolean>
      await act(() => {
        send = state.send('Inspect', { attachmentIds: [42], attachments: [attachment] })
      })
      expect(state.messages[0]).toMatchObject({ attachments: [attachment], pendingDelivery: true })
      const currentAddress = state.currentAddress!
      await act(async () => {
        response.resolve({ accepted: true, taskId: currentAddress.taskId, workspacePath: '/work' })
        expect(await send).toBe(true)
      })
      expect(state.messages[0]).toMatchObject({ attachments: [attachment], pendingDelivery: false })
      if (kind === 'new') {
        expect(mocks.create.mock.calls[0]![0].attachmentIds).toEqual([42])
        expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty('attachments')
      } else {
        expect(mocks.sendMessage.mock.calls[0]).toHaveLength(5)
        expect(mocks.sendMessage.mock.calls[0]![4]).toEqual([42])
      }
      mocks.transcript.mockResolvedValue({
        taskId: currentAddress.taskId,
        workspacePath: '/work',
        runtime: 'codex',
        messages: [
          {
            id: 'provider-user',
            clientUserMessageId: 'user-message-id',
            role: 'user',
            content: 'Inspect',
          },
        ],
      })
      await act(() =>
        state.openConversation({
          address: currentAddress,
          sourceWorkspacePath: '/work',
          title: 'Inspect',
          deviceName: 'Computer',
          projectName: null,
          updatedAt: 10,
          running: false,
        })
      )
      expect(state.messages).toHaveLength(1)
      expect(state.messages[0].attachments).toEqual([attachment])
    }
  )

  it('returns the same API instance and resolves the storage device and final worktree after work refresh', async () => {
    const work = workFor('app-record-11')
    const workspace = {
      ...work.chats[0],
      workspaceSource: 'remote',
      remoteHostId: 'storage-device',
      workspaceKind: 'worktree',
      worktreeId: 'task',
      workspacePath: '/worktree',
      tasks: [{ ...work.chats[0].tasks[0], status: 'queued' }],
    }
    mocks.listWork.mockResolvedValue({ ...work, chats: [workspace] })
    await mount()
    const api = state.api
    await act(() => state.openConversation(state.conversations[0]!))
    expect(state.fileTarget).toBeNull()
    mocks.listWork.mockResolvedValue({
      ...work,
      chats: [
        {
          ...workspace,
          tasks: [{ ...workspace.tasks[0], status: 'running' }],
        },
      ],
    })
    await act(() => state.refresh())
    expect(state.api).toBe(api)
    expect(state.fileTarget).toEqual({
      deviceId: 'storage-device',
      path: '/worktree',
      taskId: 'task',
      workspaceSource: 'remote',
    })
  })

  it('never exposes the project source while a newly requested worktree is provisional or queued', async () => {
    const work = workFor('app-record-11')
    mocks.listWork.mockResolvedValue(work)
    await mount()
    await act(() => state.startNewConversation(work.chats[0]))
    expect(state.fileTarget?.path).toBe('/work')
    const response = deferred<{
      accepted: boolean
      taskId: string
      workspacePath: string
      status: string
    }>()
    mocks.create.mockReturnValue(response.promise)
    let send!: Promise<boolean>
    await act(() => {
      send = state.send('Inspect', { worktreeBranch: 'feature/preview' })
    })
    expect(state.fileTarget).toBeNull()
    const taskId = state.currentAddress!.taskId
    await act(async () => {
      response.resolve({ accepted: true, taskId, workspacePath: '/work', status: 'queued' })
      expect(await send).toBe(true)
    })
    expect(state.fileTarget).toBeNull()
    const ready = {
      ...work.chats[0],
      workspaceKind: 'worktree',
      worktreeId: taskId,
      workspacePath: '/final-worktree',
      tasks: [{ ...work.chats[0].tasks[0], taskId, status: 'running' }],
    }
    mocks.listWork.mockResolvedValue({ ...work, chats: [ready] })
    await act(() => state.refresh())
    expect(state.fileTarget).toEqual({ deviceId: 'app-record-11', path: '/final-worktree', taskId })
  })

  it('starts model loading before the device request finishes', async () => {
    const devices = deferred<{ items: DeviceInfo[] }>()
    mocks.devices.mockReturnValue(devices.promise)
    await act(() => {
      renderer = create(<Harness />)
    })
    expect(mocks.models).toHaveBeenCalledOnce()
    expect(state.selectedModel?.name).toBe('public-model')
    expect(mocks.listWork).not.toHaveBeenCalled()
    await act(async () => {
      devices.resolve({ items: [computer] })
    })
    expect(mocks.devices).toHaveBeenCalledOnce()
    expect(mocks.listWork).toHaveBeenCalledOnce()
  })

  it.each(['new', 'existing'] as const)(
    'routes the selected computer model and reasoning through the existing %s contract',
    async kind => {
      mocks.listWork.mockResolvedValue(workFor('app-record-11'))
      mocks.nativeModels.mockResolvedValue({
        models: [
          {
            runtime: 'codex',
            provider: 'openai',
            model_id: 'gpt-6.1-sol',
            local_model_id: 'gpt-6.1-sol',
            label: 'GPT-6.1 Sol',
            account_label: 'ChatGPT',
            is_default: true,
            default_reasoning_effort: 'low',
            supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          },
        ],
      })
      await mount()
      if (kind === 'existing') await act(() => state.openConversation(state.conversations[0]!))
      await act(() => state.loadModels())
      expect(mocks.nativeModels).toHaveBeenCalledExactlyOnceWith(11)
      await act(() => state.selectModel(state.models[0], { reasoning: 'ultra' }))
      await act(async () => {
        expect(await state.send('本机模型验证')).toBe(true)
      })
      const identity = {
        runnerModelProvider: 'openai',
        codexProviderId: 'openai',
        reasoning: 'ultra',
        permissionMode: 'full-access',
      }
      if (kind === 'new') {
        expect(mocks.create).toHaveBeenCalledWith(
          expect.objectContaining({
            deviceId: 'app-record-11',
            modelId: 'gpt-6.1-sol',
            modelType: 'runtime',
            modelOptions: expect.objectContaining(identity),
          })
        )
      } else {
        expect(mocks.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ deviceId: 'app-record-11', taskId: 'task' }),
          '本机模型验证',
          'user-message-id',
          expect.objectContaining({
            modelName: 'gpt-6.1-sol',
            modelType: 'runtime',
            options: expect.objectContaining(identity),
          }),
          undefined
        )
      }
    }
  )

  it('restores full cached identities before refresh, including hidden installations', async () => {
    const optedOut: DeviceInfo = {
      ...computer,
      id: 12,
      device_id: 'second-computer',
      execution_target_id: 'app-record-12',
      socket_device_id: 'hidden-socket',
      runtime_features: {
        schemaVersion: 4,
        remoteTaskAccess: { version: 1, enabled: false },
      },
    }
    mocks.cachedDevices = [{ ...computer, socket_device_id: 'cached-socket' }, optedOut]
    const pending = deferred<{ items: DeviceInfo[] }>()
    mocks.devices.mockReturnValue(pending.promise)
    await act(async () => {
      renderer = create(<Harness />)
    })
    const inventory = mocks.streamInventory.mock.calls[0]![0] as () => DeviceInfo[]
    expect(createWorkbenchDeviceResolver(inventory()).resolve('cached-socket')?.id).toBe(11)
    expect(createWorkbenchDeviceResolver(inventory()).resolve('hidden-socket')?.id).toBe(12)
    expect(state.devices.map(device => device.id)).toEqual([11])
    const refreshed = [{ ...computer, socket_device_id: 'fresh-socket' }, optedOut]
    await act(async () => {
      pending.resolve({ items: refreshed })
    })
    expect(createWorkbenchDeviceResolver(inventory()).resolve('fresh-socket')?.id).toBe(11)
    expect(mocks.writeCache.mock.calls.at(-1)![0].devices).toEqual(refreshed)
    expect(state.devices.map(device => device.id)).toEqual([11])
  })

  it('keeps transports and loaded state when config objects or access tokens change', async () => {
    await mount()
    const conversations = state.conversations
    await act(() => renderer.update(<Harness session={{ ...config }} />))
    await act(() => renderer.update(<Harness session={{ ...config, accessToken: 'renewed' }} />))
    expect(mocks.streamCreated).toHaveBeenCalledOnce()
    expect(mocks.devices).toHaveBeenCalledOnce()
    expect(mocks.models).toHaveBeenCalledOnce()
    expect(mocks.listWork).toHaveBeenCalledOnce()
    expect(mocks.updateAccessToken).toHaveBeenLastCalledWith('renewed')
    expect(state.conversations).toBe(conversations)
  })

  it('does not wait for cache writes before loading a device task list', async () => {
    const write = deferred<void>()
    mocks.writeCache.mockReturnValue(write.promise)
    await act(() => {
      renderer = create(<Harness />)
    })
    expect(mocks.listWork).toHaveBeenCalledOnce()
    expect(state.loading).toBe(false)
    await act(() => write.resolve())
  })

  it('recovers an initial expired-token failure after authentication is refreshed', async () => {
    mocks.devices.mockRejectedValueOnce(new Error('Expired token'))
    mocks.models.mockRejectedValueOnce(new Error('Expired token'))
    await act(() => {
      renderer = create(<Harness />)
    })
    expect(state.error).toBe('Expired token')
    await act(() => renderer.update(<Harness session={{ ...config, accessToken: 'fresh' }} />))
    expect(state.selectedDeviceId).toBe('app-record-11')
    expect(state.selectedModel?.name).toBe('public-model')
    expect(mocks.devices).toHaveBeenCalledTimes(2)
    expect(mocks.models).toHaveBeenCalledTimes(2)
    expect(mocks.streamCreated).toHaveBeenCalledOnce()
  })

  it('shares one causal observation when reads overlap a newer running event', async () => {
    mocks.listWork.mockResolvedValue(workFor('app-record-11'))
    const transcript = deferred<{ taskId: string; running: boolean; messages: [] }>()
    mocks.transcript.mockReturnValue(transcript.promise)
    await act(() => {
      renderer = create(<Harness />)
    })
    let first!: Promise<void>
    let second!: Promise<void>
    const item = state.conversations[0]!
    await act(() => {
      first = state.openConversation(item)
    })
    expect(state.conversationLoading).toBe(true)
    expect(state.loading).toBe(false)
    await act(() =>
      mocks.lifecycleSubscribe.mock.calls[0]![0](item.address, {
        name: 'runtime.task.started',
        payload: {},
      })
    )
    expect(state.running).toBe(true)
    await act(() => {
      second = state.openConversation(item)
    })
    expect(mocks.transcript).toHaveBeenCalledOnce()
    await act(async () => {
      transcript.resolve({ taskId: 'task', running: false, messages: [] })
      await Promise.all([first, second])
    })
    expect(state.running).toBe(true)
  })

  it('does not preflight an existing conversation or a locally shared computer', async () => {
    mocks.listWork.mockResolvedValue(workFor('app-record-11'))
    await act(() => {
      renderer = create(<Harness />)
    })
    await act(async () => {
      await state.openConversation(state.conversations[0]!)
    })
    expect(mocks.transcript).toHaveBeenCalledOnce()
    expect(mocks.preflight).not.toHaveBeenCalled()
    await act(() => state.startNewConversation(state.work.chats[0]))
    expect(mocks.preflight).not.toHaveBeenCalled()
  })

  it('finishes loading an uncached conversation when its subscription fails and recovers', async () => {
    mocks.listWork.mockResolvedValue(workFor('app-record-11'))
    await mount()
    mocks.subscribeReady.mockRejectedValueOnce(new Error('Realtime unavailable'))
    await act(() => state.openConversation(state.conversations[0]!))
    expect(state.conversationLoading).toBe(false)
    expect(state.error).toBe('Realtime unavailable')
    expect(mocks.transcript).not.toHaveBeenCalled()
    await act(() => state.openConversation(state.conversations[0]!))
    expect(state.error).toBeNull()
    expect(state.conversationLoading).toBe(false)
    expect(mocks.transcript).toHaveBeenCalledOnce()
  })

  it('does not end another conversation loading when an old subscription fails', async () => {
    mocks.listWork.mockResolvedValue(workFor('app-record-11'))
    await mount()
    const old = deferred<void>()
    const current = deferred<void>()
    mocks.subscribeReady.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const first = state.conversations[0]!
    const second = { ...first, address: { ...first.address, taskId: 'second' } }
    let oldOpen!: Promise<void>
    let currentOpen!: Promise<void>
    await act(() => {
      oldOpen = state.openConversation(first)
    })
    await act(() => {
      currentOpen = state.openConversation(second)
    })
    await act(async () => {
      old.reject(new Error('Old subscription unavailable'))
      await oldOpen
    })
    expect(state.conversationLoading).toBe(true)
    expect(state.error).toBeNull()
    await act(async () => {
      current.resolve()
      await currentOpen
    })
    expect(state.currentAddress?.taskId).toBe('second')
    expect(state.conversationLoading).toBe(false)
  })

  it('preflights only a new cloud workspace and ignores equivalent workspace objects', async () => {
    const cloud: DeviceInfo = {
      ...computer,
      device_type: 'cloud',
      device_id: 'cloud',
      execution_target_id: null,
    }
    mocks.devices.mockResolvedValue({ items: [cloud] })
    mocks.listWork.mockResolvedValue(workFor('cloud'))
    await act(() => {
      renderer = create(<Harness />)
    })
    const workspace = state.work.chats[0]!
    await act(() => state.startNewConversation(workspace))
    expect(mocks.preflight).toHaveBeenCalledOnce()
    await act(() => state.selectWorkspace({ ...workspace }))
    expect(mocks.preflight).toHaveBeenCalledOnce()
    await act(async () => {
      await state.openConversation(state.conversations[0]!)
    })
    expect(mocks.preflight).toHaveBeenCalledOnce()
  })

  it('publishes each available device without waiting for a slow or failing peer', async () => {
    const cloud: DeviceInfo = {
      ...computer,
      device_type: 'cloud',
      device_id: 'cloud',
      execution_target_id: null,
    }
    mocks.devices.mockResolvedValue({ items: [computer, cloud] })
    await act(() => {
      renderer = create(<Harness />)
    })
    const slow = deferred<RuntimeWorkListResponse>()
    mocks.listWork.mockImplementation((id: string) =>
      id === 'cloud' ? slow.promise : Promise.resolve(workFor(id))
    )
    await act(() => state.selectAllDevices())
    expect(state.conversations.map(item => item.address.deviceId)).toEqual(['app-record-11'])
    expect(state.loading).toBe(false)
    await act(async () => {
      slow.reject(new Error('peer offline'))
    })
    expect(state.conversations).toHaveLength(1)
    expect(state.error).toBe('peer offline')
  })

  it('creates on the record-scoped computer using the existing standalone task intent', async () => {
    await mount()
    let sent = false
    await act(async () => {
      sent = await state.send('你好')
    })
    expect(sent).toBe(true)
    expect(mocks.order).toEqual(['subscribe', 'create'])
    const payload = mocks.create.mock.calls[0]![0]
    expect(mocks.homeDirectory).not.toHaveBeenCalled()
    expect(mocks.createDirectory).not.toHaveBeenCalled()
    expect(payload).not.toHaveProperty('workspacePath')
    expect(payload).toMatchObject({
      deviceId: 'app-record-11',
      message: '你好',
      standaloneChatWorkspace: true,
      modelId: 'public-model',
      modelType: 'public',
    })
    expect(state.currentAddress).toMatchObject({
      deviceId: 'app-record-11',
      taskId: payload.taskId,
      workspacePath: '/Users/owner/Documents/Codex/task',
    })
  })

  it('uses the same creatable device as the composer when the selected device is read-only', async () => {
    const readOnly: DeviceInfo = {
      ...computer,
      id: 12,
      device_id: 'read-only-computer',
      execution_target_id: 'app-record-12',
      runtime_features: {
        schemaVersion: 4,
        remoteTaskAccess: { version: 1, enabled: true, taskCreation: false },
      },
    }
    mocks.devices.mockResolvedValue({ items: [computer, readOnly] })
    await mount()
    await act(() => state.selectDevice('app-record-12'))
    await act(async () => {
      expect(await state.send('你好')).toBe(true)
    })
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'app-record-11' })
    )
  })

  it('moves the draft to the canonical task ID before its first live event', async () => {
    await mount()
    mocks.create.mockResolvedValue({ accepted: true, taskId: 'canonical', workspacePath: '/work' })
    await act(async () => {
      expect(await state.send('你好')).toBe(true)
    })
    const [scope, listener] = mocks.conversationSubscribe.mock.calls.at(-1)!
    expect(scope.taskId).toBe('canonical')
    await act(() =>
      listener({
        name: 'response.output_text.delta',
        payload: { taskId: 'canonical', subtaskId: 'turn', data: { delta: 'Live', offset: 0 } },
      })
    )
    expect(state.messages.map(message => message.content)).toEqual(['你好', 'Live'])
    expect(state.currentAddress?.taskId).toBe('canonical')
  })

  it('keeps an accepted task when its canonical subscription fails', async () => {
    await mount()
    mocks.create.mockResolvedValue({ accepted: true, taskId: 'canonical', workspacePath: '/work' })
    mocks.subscribeReady
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Realtime unavailable'))
    await act(async () => {
      expect(await state.send('你好')).toBe(true)
    })
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(state.currentAddress?.taskId).toBe('canonical')
    expect(state.error).toBe('Realtime unavailable')
    expect(state.messages[0]?.content).toBe('你好')
    expect(state.messages.every(message => message.status !== 'failed')).toBe(true)
  })

  it('hydrates a canonical task completed before its subscription was installed', async () => {
    await mount()
    mocks.create.mockResolvedValue({ accepted: true, taskId: 'canonical', workspacePath: '/work' })
    mocks.transcript.mockImplementation(async address => {
      expect(mocks.conversationSubscribe.mock.calls.at(-1)?.[0].taskId).toBe('canonical')
      expect(address.taskId).toBe('canonical')
      return {
        taskId: 'canonical',
        running: false,
        messages: [{ id: 'reply', role: 'assistant', content: 'Fast reply', status: 'completed' }],
      }
    })
    await act(async () => {
      expect(await state.send('你好')).toBe(true)
    })
    expect(mocks.transcript).toHaveBeenCalledOnce()
    expect(state.messages.some(message => message.content === 'Fast reply')).toBe(true)
    expect(state.running).toBe(false)
  })

  it('does not navigate back when task creation finishes after leaving the conversation', async () => {
    await mount()
    const created = deferred<{ accepted: boolean; taskId: string; workspacePath: string }>()
    mocks.create.mockReturnValue(created.promise)
    let send!: Promise<boolean>
    await act(() => {
      send = state.send('你好')
    })
    await act(() => state.startNewConversation())
    await act(async () => {
      created.resolve({ accepted: true, taskId: 'canonical', workspacePath: '/work' })
      expect(await send).toBe(true)
    })
    expect(state.currentAddress).toBeNull()
    expect(state.messages).toEqual([])
  })

  it.each(['cloud', 'remote'] as const)(
    'creates on a %s device through the existing PC home_dir and mkdir_p flow',
    async deviceType => {
      mocks.devices.mockResolvedValue({
        items: [{ ...computer, device_type: deviceType, device_id: 'existing-device' }],
      })
      await act(() => {
        renderer = create(<Harness />)
      })
      await act(() => state.startNewConversation())
      let sent = false
      await act(async () => {
        sent = await state.send('你好')
      })
      expect(sent).toBe(true)
      expect(mocks.order).toEqual(['home_dir', 'mkdir_p', 'subscribe', 'create'])
      const payload = mocks.create.mock.calls[0]![0]
      expect(mocks.homeDirectory).toHaveBeenCalledWith('existing-device')
      expect(mocks.createDirectory).toHaveBeenCalledWith('existing-device', payload.workspacePath)
      expect(payload.workspacePath).toMatch(
        /^\/Users\/owner\/Documents\/Codex\/\d{4}-\d{2}-\d{2}\/new-chat-/
      )
      expect(payload).not.toHaveProperty('standaloneChatWorkspace')
    }
  )

  it('does not issue directory commands when using a selected workspace', async () => {
    mocks.listWork.mockResolvedValue(workFor('app-record-11'))
    await mount()
    await act(() => state.startNewConversation(state.work.chats[0]))
    await act(async () => {
      await state.send('你好')
    })
    expect(mocks.homeDirectory).not.toHaveBeenCalled()
    expect(mocks.createDirectory).not.toHaveBeenCalled()
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ workspacePath: '/work' })
    expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty('standaloneChatWorkspace')
  })

  it.each(['homeDirectory', 'createDirectory'] as const)(
    'keeps the draft and does not create a task when %s fails',
    async operation => {
      mocks.devices.mockResolvedValue({
        items: [{ ...computer, device_type: 'remote', device_id: 'existing-device' }],
      })
      mocks[operation].mockRejectedValue(new Error('Device directory unavailable'))
      await act(() => {
        renderer = create(<Harness />)
      })
      await act(() => state.startNewConversation())
      await act(async () => {
        expect(await state.send('你好')).toBe(false)
      })
      expect(mocks.create).not.toHaveBeenCalled()
      expect(state.currentAddress).toBeNull()
      expect(state.error).toBe('Device directory unavailable')
      expect(state.sending).toBe(false)
    }
  )

  it.each(['new', 'existing'] as const)(
    'waits for the realtime subscription before sending a %s conversation',
    async kind => {
      mocks.listWork.mockResolvedValue(workFor('app-record-11'))
      await mount()
      if (kind === 'existing') await act(() => state.openConversation(state.conversations[0]!))
      const ready = deferred<void>()
      mocks.subscribeReady.mockReturnValue(ready.promise)
      const operation = kind === 'new' ? mocks.create : mocks.sendMessage
      let send!: Promise<boolean>
      await act(() => {
        send = state.send('你好')
      })
      expect(state.sending).toBe(true)
      expect(operation).not.toHaveBeenCalled()
      await act(async () => {
        ready.resolve()
        expect(await send).toBe(true)
      })
      expect(operation).toHaveBeenCalledOnce()
    }
  )

  it.each(['new', 'existing'] as const)(
    'does not start a %s conversation without a realtime connection',
    async kind => {
      mocks.listWork.mockResolvedValue(workFor('app-record-11'))
      await mount()
      if (kind === 'existing') await act(() => state.openConversation(state.conversations[0]!))
      mocks.subscribeReady.mockRejectedValue(new Error('Realtime connection unavailable'))
      await act(async () => {
        expect(await state.send('你好')).toBe(false)
      })
      expect(mocks.create).not.toHaveBeenCalled()
      expect(mocks.sendMessage).not.toHaveBeenCalled()
      expect(state.sending).toBe(false)
      expect(state.running).toBe(false)
      expect(state.error).toBe('Realtime connection unavailable')
    }
  )

  it.each(['new', 'existing'] as const)(
    'cancels a pending %s subscription when the conversation changes',
    async kind => {
      mocks.listWork.mockResolvedValue(workFor('app-record-11'))
      await mount()
      if (kind === 'existing') await act(() => state.openConversation(state.conversations[0]!))
      const ready = deferred<void>()
      mocks.subscribeReady.mockReturnValue(ready.promise)
      let send!: Promise<boolean>
      await act(() => {
        send = state.send('你好')
      })
      const [scope, listener] = mocks.conversationSubscribe.mock.calls.at(-1)!
      await act(() => state.startNewConversation())
      await act(() =>
        listener({
          name: 'response.output_text.delta',
          payload: {
            deviceId: scope.deviceId,
            taskId: scope.taskId,
            subtaskId: 'old-turn',
            data: { delta: 'old conversation' },
          },
        })
      )
      await act(async () => {
        ready.resolve()
        expect(await send).toBe(false)
      })
      expect(mocks.create).not.toHaveBeenCalled()
      expect(mocks.sendMessage).not.toHaveBeenCalled()
      expect(state.messages).toEqual([])
      expect(state.error).toBeNull()
      expect(state.running).toBe(false)
    }
  )

  it.each(['new', 'existing'] as const)(
    'renders each delta while a %s conversation send is pending',
    async kind => {
      mocks.listWork.mockResolvedValue(workFor('app-record-11'))
      await mount()
      if (kind === 'existing') {
        await act(() => state.openConversation(state.conversations[0]!))
      }
      const response = deferred<{ accepted: boolean; taskId: string; workspacePath: string }>()
      const operation = kind === 'new' ? mocks.create : mocks.sendMessage
      operation.mockReturnValue(response.promise)
      let send!: Promise<boolean>
      await act(() => {
        send = state.send('你好')
      })
      expect(state.sending).toBe(true)
      expect(state.running).toBe(true)
      expect(state.messages.at(-1)?.content).toBe('你好')
      const [scope, listener] = mocks.conversationSubscribe.mock.calls.at(-1)!
      for (const [event, data, text] of [
        ['response.created', {}, ''],
        ['response.output_text.delta', { itemId: 'text', delta: '你', offset: 0 }, '你'],
        ['response.output_text.delta', { itemId: 'text', delta: '好', offset: 1 }, '你好'],
      ] as const) {
        await act(() =>
          listener({
            name: event,
            payload: {
              deviceId: scope.deviceId,
              taskId: scope.taskId,
              subtaskId: 'turn',
              data,
            },
          })
        )
        expect(state.messages.at(-1)).toMatchObject({
          role: 'assistant',
          status: 'streaming',
          content: text,
        })
      }
      await act(async () => {
        response.resolve({ accepted: true, taskId: scope.taskId, workspacePath: '/work' })
        expect(await send).toBe(true)
      })
      expect(state.messages.map(message => message.content)).toEqual(['你好', '你好'])
    }
  )

  it('surfaces locally revoked consent from the existing task creation interface', async () => {
    mocks.create.mockRejectedValue(new Error('Local switch is off'))
    await mount()
    let sent = true
    await act(async () => {
      sent = await state.send('你好')
    })
    expect(sent).toBe(false)
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(mocks.homeDirectory).not.toHaveBeenCalled()
    expect(state.currentAddress).toBeNull()
    expect(state.error).toBe('Local switch is off')
  })

  it('clears the provisional conversation when task creation is rejected', async () => {
    mocks.create.mockResolvedValue({ accepted: false, error: 'Access revoked' })
    await mount()
    await act(async () => {
      expect(await state.send('你好')).toBe(false)
    })
    expect(state.currentAddress).toBeNull()
    expect(state.error).toBe('Access revoked')
    expect(state.sending).toBe(false)
  })
})
