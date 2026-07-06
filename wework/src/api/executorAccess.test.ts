import { describe, expect, test, vi } from 'vitest'
import { createExecutorClientFromApis } from './executorAccess'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'

function createDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'Executor',
    status: 'online',
    is_default: true,
    device_type: 'cloud',
    capabilities: ['runtime-work', 'device-commands'],
    executor_version: '1.8.5',
    ...overrides,
  }
}

function createRuntimeWork(): RuntimeWorkListResponse {
  return {
    projects: [],
    chats: [],
    totalTasks: 0,
  }
}

function createApis(devices: DeviceInfo[] = [createDevice()]) {
  const deviceApi = {
    listDevices: vi.fn().mockResolvedValue(devices),
    getHomeDirectory: vi.fn().mockResolvedValue('/Users/me'),
    getProjectWorkspaceRoot: vi.fn().mockResolvedValue('/Users/me/Documents'),
    listDirectories: vi.fn().mockResolvedValue(['/Users/me/project']),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue({
      success: true,
      stdout: 'ok',
      stderr: '',
      exit_code: 0,
    }),
    upgradeDevice: vi.fn().mockResolvedValue({ accepted: true }),
    listSkills: vi.fn().mockResolvedValue([]),
    listWorkspaceEntries: vi.fn().mockResolvedValue({
      path: '/Users/me/project',
      entries: [],
    }),
    readWorkspaceTextFile: vi.fn().mockResolvedValue({
      path: '/Users/me/project/README.md',
      name: 'README.md',
      content: 'hello',
      truncated: false,
      size: 5,
    }),
  }
  const runtimeWorkApi = {
    listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork()),
    prepareDeviceWorkspace: vi.fn(),
    deleteDeviceWorkspace: vi.fn(),
    getRuntimeTranscript: vi.fn(),
    searchRuntimeWork: vi.fn(),
    revertRuntimeFileChanges: vi.fn(),
    sendRuntimeMessage: vi.fn(),
    rollbackRuntimeTask: vi.fn(),
    openRuntimeWorkspace: vi.fn(),
    renameRuntimeWorkspace: vi.fn(),
    removeRuntimeWorkspace: vi.fn(),
    archiveRuntimeTask: vi.fn(),
    renameRuntimeTask: vi.fn(),
    listArchivedConversations: vi.fn(),
    archiveConversation: vi.fn(),
    archiveProjectConversations: vi.fn(),
    archiveAllConversations: vi.fn(),
    unarchiveConversation: vi.fn(),
    deleteArchivedConversation: vi.fn(),
    deleteArchivedConversationsBulk: vi.fn(),
    cancelRuntimeTask: vi.fn(),
    createRuntimeTask: vi.fn(),
    forkRuntimeTask: vi.fn(),
  }
  return { deviceApi, runtimeWorkApi }
}

describe('executor access layer', () => {
  test('refreshes the registry from the configured transport device list', async () => {
    const { deviceApi, runtimeWorkApi } = createApis()
    const client = createExecutorClientFromApis({
      transportKind: 'backend-relay',
      deviceApi,
      runtimeWorkApi,
    })

    await expect(client.commands.listDevices()).resolves.toEqual([createDevice()])
    expect(client.registry.list()).toEqual([
      expect.objectContaining({
        deviceId: 'device-1',
        transportKind: 'backend-relay',
        capabilities: ['runtime-work', 'device-commands'],
      }),
    ])
  })

  test('routes file access through the executor file capability', async () => {
    const { deviceApi, runtimeWorkApi } = createApis()
    const client = createExecutorClientFromApis({
      transportKind: 'local-ipc',
      deviceApi,
      runtimeWorkApi,
    })

    await expect(
      client.files.listWorkspaceEntries('device-1', '/Users/me/project')
    ).resolves.toEqual({
      path: '/Users/me/project',
      entries: [],
    })
    await expect(
      client.files.readWorkspaceTextFile('device-1', '/Users/me/project/README.md')
    ).resolves.toMatchObject({ content: 'hello' })

    expect(deviceApi.listWorkspaceEntries).toHaveBeenCalledWith('device-1', '/Users/me/project')
    expect(deviceApi.readWorkspaceTextFile).toHaveBeenCalledWith(
      'device-1',
      '/Users/me/project/README.md'
    )
  })

  test('normalizes unknown devices into executor-not-found errors', async () => {
    const { deviceApi, runtimeWorkApi } = createApis()
    const client = createExecutorClientFromApis({
      transportKind: 'backend-relay',
      deviceApi,
      runtimeWorkApi,
    })

    await expect(client.commands.getHomeDirectory('missing-device')).rejects.toThrow(
      'executor-not-found:missing-device'
    )
    expect(deviceApi.getHomeDirectory).not.toHaveBeenCalled()
  })

  test('passes aggregate runtime work calls to the runtime transport', async () => {
    const { runtimeWorkApi, deviceApi } = createApis()
    const client = createExecutorClientFromApis({
      transportKind: 'backend-relay',
      deviceApi,
      runtimeWorkApi,
    })

    await expect(client.runtime.listRuntimeWork()).resolves.toEqual(createRuntimeWork())
    expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(1)
  })
})
