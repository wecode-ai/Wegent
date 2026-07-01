import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getModelExecutionOverride } from '@/features/cloud-connection/modelExecution'
import { createHybridWorkbenchServices } from './hybridServices'

const mocks = vi.hoisted(() => {
  const localCreateRuntimeTask = vi.fn()
  const cloudCreateRuntimeTask = vi.fn()
  const localListDevices = vi.fn()
  const cloudListDevices = vi.fn()
  const localListRuntimeWork = vi.fn()
  const cloudListRuntimeWork = vi.fn()
  const localListModels = vi.fn()
  const cloudListModels = vi.fn()
  const localListTeams = vi.fn()
  const localGetDefaultWorkbenchTeam = vi.fn()
  const localListSkills = vi.fn()
  const localGetTeamSkills = vi.fn()
  const cloudListTeams = vi.fn()
  const cloudGetDefaultWorkbenchTeam = vi.fn()
  const localSearchRuntimeWork = vi.fn()
  const cloudSearchRuntimeWork = vi.fn()
  const cloudCreateDockerRemoteDeviceCommand = vi.fn()

  const localServices = {
    teamApi: {
      listTeams: localListTeams,
      getDefaultWorkbenchTeam: localGetDefaultWorkbenchTeam,
    },
    modelApi: { listModels: localListModels },
    skillApi: {
      listSkills: localListSkills,
      getTeamSkills: localGetTeamSkills,
    },
    deviceApi: {
      listDevices: localListDevices,
      getHomeDirectory: vi.fn(),
      getProjectWorkspaceRoot: vi.fn(),
      listDirectories: vi.fn(),
      createDirectory: vi.fn(),
      executeCommand: vi.fn(),
      upgradeDevice: vi.fn(),
      listSkills: vi.fn(),
      listWorkspaceEntries: vi.fn(),
      readWorkspaceTextFile: vi.fn(),
    },
    runtimeWorkApi: {
      listRuntimeWork: localListRuntimeWork,
      createRuntimeTask: localCreateRuntimeTask,
      searchRuntimeWork: localSearchRuntimeWork,
      listArchivedConversations: vi.fn(async () => ({
        items: [],
        projectGroups: [],
        total: 0,
      })),
      archiveAllConversations: vi.fn(async () => ({
        accepted: true,
        requestedCount: 0,
        acceptedCount: 0,
        deletedCount: 0,
        results: [],
      })),
    },
    chatStream: { subscribe: vi.fn(() => vi.fn()) },
  }

  const cloudServices = {
    teamApi: {
      listTeams: cloudListTeams,
      getDefaultWorkbenchTeam: cloudGetDefaultWorkbenchTeam,
    },
    modelApi: { listModels: cloudListModels },
    skillApi: {},
    projectApi: {},
    taskApi: { getTurnFileChangesDiff: vi.fn() },
    deviceApi: {
      listDevices: cloudListDevices,
      getHomeDirectory: vi.fn(),
      getProjectWorkspaceRoot: vi.fn(),
      listDirectories: vi.fn(),
      createDirectory: vi.fn(),
      executeCommand: vi.fn(),
      upgradeDevice: vi.fn(),
      listSkills: vi.fn(),
      listWorkspaceEntries: vi.fn(),
      readWorkspaceTextFile: vi.fn(),
      createDockerRemoteDeviceCommand: cloudCreateDockerRemoteDeviceCommand,
    },
    runtimeWorkApi: {
      listRuntimeWork: cloudListRuntimeWork,
      createRuntimeTask: cloudCreateRuntimeTask,
      searchRuntimeWork: cloudSearchRuntimeWork,
      listArchivedConversations: vi.fn(async () => ({
        items: [],
        projectGroups: [],
        total: 0,
      })),
      archiveAllConversations: vi.fn(async () => ({
        accepted: true,
        requestedCount: 0,
        acceptedCount: 0,
        deletedCount: 0,
        results: [],
      })),
      getImNotificationSettings: vi.fn(),
    },
    chatStream: { subscribe: vi.fn(() => vi.fn()) },
    socketClient: { ensureConnected: vi.fn(), dispose: vi.fn() },
  }

  return {
    localCreateRuntimeTask,
    cloudCreateRuntimeTask,
    localListDevices,
    cloudListDevices,
    localListRuntimeWork,
    cloudListRuntimeWork,
    localListModels,
    cloudListModels,
    localListTeams,
    localGetDefaultWorkbenchTeam,
    localListSkills,
    localGetTeamSkills,
    cloudListTeams,
    cloudGetDefaultWorkbenchTeam,
    localSearchRuntimeWork,
    cloudSearchRuntimeWork,
    cloudCreateDockerRemoteDeviceCommand,
    localServices,
    cloudServices,
  }
})

vi.mock('@/api/local/localServices', () => ({
  createLocalAppServices: () => mocks.localServices,
}))

vi.mock('@/api/backend/backendServices', () => ({
  createBackendWorkbenchServices: () => mocks.cloudServices,
}))

const codexModel = {
  name: 'codex-gpt-5.5',
  type: 'runtime',
  displayName: 'GPT-5.5 (Codex)',
  config: {
    protocol: 'openai-responses',
    ui: { family: 'gpt', modelLabel: 'GPT-5.5' },
  },
  runtime: { family: 'openai.openai-responses' },
  isActive: true,
}

function createServices() {
  return createHybridWorkbenchServices({
    backendUrl: 'https://cloud.example.com',
    apiBaseUrl: 'https://cloud.example.com/api',
    socketBaseUrl: 'https://cloud.example.com',
    socketPath: '/socket.io',
    token: 'cloud-token',
  })
}

describe('createHybridWorkbenchServices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.localListRuntimeWork.mockResolvedValue({ projects: [], chats: [], totalLocalTasks: 0 })
    mocks.cloudListRuntimeWork.mockResolvedValue({ projects: [], chats: [], totalLocalTasks: 0 })
    mocks.localListDevices.mockResolvedValue([
      {
        id: 0,
        device_id: 'local-device',
        name: 'Local Executor',
        status: 'online',
        is_default: true,
        device_type: 'local',
        bind_shell: 'claudecode',
      },
    ])
    mocks.localListTeams.mockResolvedValue([
      { id: 0, name: 'local-wework', is_active: true, default_for_modes: ['wework'] },
    ])
    mocks.localGetDefaultWorkbenchTeam.mockResolvedValue({
      id: 0,
      name: 'local-wework',
      is_active: true,
      default_for_modes: ['wework'],
    })
    mocks.localListSkills.mockResolvedValue([])
    mocks.localGetTeamSkills.mockResolvedValue({ skills: [], preload_skills: [] })
    mocks.cloudListTeams.mockResolvedValue([
      { id: 1, name: 'cloud-wework', is_active: true, default_for_modes: ['wework'] },
    ])
    mocks.cloudGetDefaultWorkbenchTeam.mockResolvedValue({
      id: 1,
      name: 'cloud-wework',
      is_active: true,
      default_for_modes: ['wework'],
    })
    mocks.cloudListDevices.mockResolvedValue([
      {
        id: 1,
        device_id: 'cloud-device',
        name: 'Cloud Executor',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
        bind_shell: 'claudecode',
      },
    ])
    mocks.localListModels.mockResolvedValue({ data: [codexModel] })
    mocks.cloudListModels.mockResolvedValue({ data: [codexModel] })
    mocks.localSearchRuntimeWork.mockResolvedValue({ items: [] })
    mocks.cloudSearchRuntimeWork.mockResolvedValue({ items: [] })
    mocks.cloudCreateDockerRemoteDeviceCommand.mockResolvedValue({
      device_id: 'remote-device',
      name: 'Remote Device',
      image: 'ghcr.io/wecode-ai/wegent-device:latest',
      env: {},
      command: 'docker run',
      commands: [
        { kind: 'docker', label: 'Docker', command: 'docker run' },
        { kind: 'process', label: 'Process', command: 'wegent-executor' },
      ],
    })
  })

  it('gives local and cloud Codex models unique UI names', async () => {
    const services = createServices()
    const response = await services.modelApi.listModels()

    expect(response.data.map(model => model.name)).toEqual([
      'local:runtime:codex-gpt-5.5',
      'cloud:runtime:codex-gpt-5.5',
    ])
    expect(response.data.map(model => getModelExecutionOverride(model)?.modelName)).toEqual([
      'codex-gpt-5.5',
      'codex-gpt-5.5',
    ])
  })

  it('keeps default team and skills on the local services', async () => {
    const services = createServices()

    await expect(services.teamApi.getDefaultWorkbenchTeam()).resolves.toMatchObject({
      id: 0,
      name: 'local-wework',
    })
    await expect(services.skillApi.getTeamSkills(0)).resolves.toEqual({
      skills: [],
      preload_skills: [],
    })
    expect(mocks.cloudGetDefaultWorkbenchTeam).not.toHaveBeenCalled()
  })

  it('returns local devices from the primary device list', async () => {
    const services = createServices()
    const devices = await services.deviceApi.listDevices()

    expect(devices.map(device => device.device_id)).toEqual(['local-device'])
    expect(mocks.cloudListDevices).not.toHaveBeenCalled()
  })

  it('does not wait for cloud device or runtime-work reads on the primary path', async () => {
    mocks.cloudListDevices.mockReturnValue(new Promise(() => undefined))
    mocks.cloudListRuntimeWork.mockReturnValue(new Promise(() => undefined))
    mocks.localListRuntimeWork.mockResolvedValue({
      projects: [
        {
          project: { key: 'local', name: 'Local' },
          totalLocalTasks: 0,
          deviceWorkspaces: [],
        },
      ],
      chats: [],
      totalLocalTasks: 0,
    })

    const services = createServices()
    const [devices, runtimeWork] = await Promise.all([
      services.deviceApi.listDevices(),
      services.runtimeWorkApi?.listRuntimeWork(),
    ])

    expect(devices.map(device => device.device_id)).toEqual(['local-device'])
    expect(runtimeWork?.projects.map(project => project.project.key)).toEqual(['local'])
    expect(mocks.cloudListDevices).not.toHaveBeenCalled()
    expect(mocks.cloudListRuntimeWork).not.toHaveBeenCalled()
  })

  it('does not expose the current app registration as a background cloud work device', async () => {
    mocks.cloudListDevices.mockResolvedValue([
      {
        id: 1,
        device_id: 'local-device',
        name: 'Current App Registration',
        status: 'online',
        is_default: false,
        device_type: 'app',
        app_device_id: 'local-device',
        bind_shell: 'claudecode',
      },
      {
        id: 2,
        device_id: 'cloud-device',
        name: 'Cloud Executor',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
        bind_shell: 'claudecode',
      },
    ])

    const services = createServices()
    await services.deviceApi.listDevices()
    const devices = await services.cloudBackgroundApi?.listDevices?.()

    expect(devices?.map(device => device.device_id)).toEqual(['cloud-device'])
  })

  it('removes current app registration work from background runtime work', async () => {
    mocks.cloudListRuntimeWork.mockResolvedValue({
      projects: [
        {
          project: { key: 'app', name: 'Current App' },
          totalLocalTasks: 1,
          deviceWorkspaces: [
            {
              deviceId: 'local-device',
              deviceName: 'Current App Registration',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/app',
              localTasks: [
                {
                  localTaskId: 'app-task',
                  workspacePath: '/app',
                  title: 'App task',
                  runtime: 'codex',
                },
              ],
            },
          ],
        },
        {
          project: { key: 'cloud', name: 'Cloud' },
          totalLocalTasks: 1,
          deviceWorkspaces: [
            {
              deviceId: 'cloud-device',
              deviceName: 'Cloud Executor',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/cloud',
              localTasks: [
                {
                  localTaskId: 'cloud-task',
                  workspacePath: '/cloud',
                  title: 'Cloud task',
                  runtime: 'codex',
                },
              ],
            },
          ],
        },
      ],
      chats: [
        {
          deviceId: 'local-device',
          deviceName: 'Current App Registration',
          deviceStatus: 'online',
          available: true,
          workspacePath: '/app-chat',
          workspaceKind: 'chat',
          localTasks: [
            {
              localTaskId: 'app-chat',
              workspacePath: '/app-chat',
              title: 'App chat',
              runtime: 'codex',
            },
          ],
        },
      ],
      totalLocalTasks: 3,
    })

    const services = createServices()
    await services.deviceApi.listDevices()
    const runtimeWork = await services.cloudBackgroundApi?.listRuntimeWork?.()

    expect(runtimeWork?.projects.map(project => project.project.key)).toEqual(['cloud'])
    expect(runtimeWork?.chats).toEqual([])
    expect(runtimeWork?.totalLocalTasks).toBe(1)
  })

  it('routes runtime task creation by device source', async () => {
    const services = createServices()
    await services.deviceApi.listDevices()
    mocks.localCreateRuntimeTask.mockResolvedValue({
      accepted: true,
      deviceId: 'local-device',
      localTaskId: 'local-task',
      workspacePath: '/tmp/local',
    })
    mocks.cloudCreateRuntimeTask.mockResolvedValue({
      accepted: true,
      deviceId: 'cloud-device',
      localTaskId: 'cloud-task',
      workspacePath: '/tmp/cloud',
    })

    await services.runtimeWorkApi?.createRuntimeTask({
      deviceId: 'local-device',
      workspacePath: '/tmp/local',
      teamId: 1,
      runtime: 'codex',
      message: 'local',
    })
    await services.runtimeWorkApi?.createRuntimeTask({
      deviceId: 'cloud-device',
      workspacePath: '/tmp/cloud',
      teamId: 1,
      runtime: 'codex',
      message: 'cloud',
    })

    expect(mocks.localCreateRuntimeTask).toHaveBeenCalledTimes(1)
    expect(mocks.cloudCreateRuntimeTask).toHaveBeenCalledTimes(1)
  })

  it('sorts merged search results by updated time before applying the limit', async () => {
    const services = createServices()
    mocks.localSearchRuntimeWork.mockResolvedValue({
      items: [
        {
          address: { deviceId: 'local-device', localTaskId: 'local-task' },
          runtime: 'codex',
          title: 'Older local result',
          snippet: 'local',
          matchStart: 0,
          matchEnd: 5,
          updatedAt: '2026-01-01T00:00:00Z',
          deviceName: 'Local Executor',
          workspacePath: '/tmp/local',
        },
      ],
    })
    mocks.cloudSearchRuntimeWork.mockResolvedValue({
      items: [
        {
          address: { deviceId: 'cloud-device', localTaskId: 'cloud-task' },
          runtime: 'codex',
          title: 'Newer cloud result',
          snippet: 'cloud',
          matchStart: 0,
          matchEnd: 5,
          updatedAt: '2026-01-02T00:00:00Z',
          deviceName: 'Cloud Executor',
          workspacePath: '/tmp/cloud',
        },
      ],
    })

    const response = await services.runtimeWorkApi?.searchRuntimeWork({
      query: 'result',
      limit: 1,
    })

    expect(response?.items.map(item => item.title)).toEqual(['Newer cloud result'])
  })

  it('routes remote device startup command generation to the cloud service', async () => {
    const services = createServices()

    const response = await services.deviceApi.createDockerRemoteDeviceCommand?.({
      client_origin: 'http://localhost:1420',
    })

    expect(mocks.cloudCreateDockerRemoteDeviceCommand).toHaveBeenCalledWith({
      client_origin: 'http://localhost:1420',
    })
    expect(response?.commands?.map(command => command.kind)).toEqual(['docker', 'process'])
  })
})
