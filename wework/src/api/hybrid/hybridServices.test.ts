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
  const localListProjects = vi.fn()
  const localUpdateCurrentUser = vi.fn()
  const localListSkills = vi.fn()
  const localGetTeamSkills = vi.fn()
  const cloudListTeams = vi.fn()
  const cloudGetDefaultWorkbenchTeam = vi.fn()
  const localSearchRuntimeWork = vi.fn()
  const localGetWorktreeSettings = vi.fn()
  const cloudSearchRuntimeWork = vi.fn()
  const cloudCreateDockerRemoteDeviceCommand = vi.fn()
  const cloudRuntimeIpcRequest = vi.fn()
  const cloudRuntimeIpcSubscribe = vi.fn(async () => vi.fn())
  const captureRuntimeIpcOptions = vi.fn()
  const localListArchivedConversations = vi.fn()
  const cloudListArchivedConversations = vi.fn()
  const localArchiveAllConversations = vi.fn()
  const cloudArchiveAllConversations = vi.fn()
  const localArchiveProjectConversations = vi.fn()
  const cloudArchiveProjectConversations = vi.fn()
  const cloudWorkspaceSessionApi = {
    startProjectTerminal: vi.fn(),
    startProjectCodeServer: vi.fn(),
    startDeviceTerminal: vi.fn(),
    startDeviceCodeServer: vi.fn(),
    createRemoteTerminalClient: vi.fn(),
  }

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
    projectApi: { listProjects: localListProjects },
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
      rollbackRuntimeTask: vi.fn(),
      compactRuntimeTask: vi.fn(),
      searchRuntimeWork: localSearchRuntimeWork,
      getWorktreeSettings: localGetWorktreeSettings,
      listArchivedConversations: localListArchivedConversations,
      archiveAllConversations: localArchiveAllConversations,
      archiveProjectConversations: localArchiveProjectConversations,
    },
    userApi: { updateCurrentUser: localUpdateCurrentUser },
    chatStream: { subscribe: vi.fn(() => vi.fn()) },
  }

  const cloudServices = {
    teamApi: {
      listTeams: cloudListTeams,
      getDefaultWorkbenchTeam: cloudGetDefaultWorkbenchTeam,
    },
    modelApi: { listModels: cloudListModels },
    skillApi: {},
    projectApi: { listProjects: vi.fn() },
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
      rollbackRuntimeTask: vi.fn(),
      compactRuntimeTask: vi.fn(),
      searchRuntimeWork: cloudSearchRuntimeWork,
      listArchivedConversations: cloudListArchivedConversations,
      archiveAllConversations: cloudArchiveAllConversations,
      archiveProjectConversations: cloudArchiveProjectConversations,
      getImNotificationSettings: vi.fn(),
    },
    chatStream: { subscribe: vi.fn(() => vi.fn()) },
    socketClient: { ensureConnected: vi.fn(), dispose: vi.fn() },
    workspaceSessionApi: cloudWorkspaceSessionApi,
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
    localListProjects,
    localUpdateCurrentUser,
    localListSkills,
    localGetTeamSkills,
    cloudListTeams,
    cloudGetDefaultWorkbenchTeam,
    localSearchRuntimeWork,
    localGetWorktreeSettings,
    cloudSearchRuntimeWork,
    cloudCreateDockerRemoteDeviceCommand,
    cloudRuntimeIpcRequest,
    cloudRuntimeIpcSubscribe,
    captureRuntimeIpcOptions,
    localListArchivedConversations,
    cloudListArchivedConversations,
    localArchiveAllConversations,
    cloudArchiveAllConversations,
    localArchiveProjectConversations,
    cloudArchiveProjectConversations,
    cloudWorkspaceSessionApi,
    localServices,
    cloudServices,
  }
})

vi.mock('@/api/local/localServices', () => ({
  createLocalAppServices: () => mocks.localServices,
  createRuntimeWorkApiFromIpc: (
    request: (
      method: string,
      params?: Record<string, unknown>,
      deviceId?: string
    ) => Promise<unknown>,
    getDefaultDeviceId: () => Promise<string>,
    options: Record<string, unknown>
  ) => {
    mocks.captureRuntimeIpcOptions(options)
    return {
      async listRuntimeWork() {
        const deviceId = await getDefaultDeviceId()
        return request('runtime.tasks.list', {}, deviceId)
      },
      createRuntimeTask(data: Record<string, unknown>) {
        return request('runtime.tasks.create', data, String(data.deviceId))
      },
      rollbackRuntimeTask(data: Record<string, unknown>) {
        return request('runtime.tasks.rollback', data, String(data.deviceId))
      },
      compactRuntimeTask(data: Record<string, unknown>) {
        return request('runtime.tasks.compact', data, String(data.deviceId))
      },
      async searchRuntimeWork(data: Record<string, unknown>) {
        return request(
          'runtime.tasks.search',
          data,
          String(data.deviceId ?? (await getDefaultDeviceId()))
        )
      },
      getWorktreeSettings(data: Record<string, unknown>) {
        return request('runtime.worktrees.settings.get', data, String(data.deviceId))
      },
      listWorktrees(data: Record<string, unknown>) {
        return request('runtime.worktrees.list', data, String(data.deviceId))
      },
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
    }
  },
}))

vi.mock('@/api/backend/backendServices', () => ({
  createBackendWorkbenchServices: () => mocks.cloudServices,
}))

vi.mock('@/api/backend/runtimeIpc', () => ({
  createCloudRuntimeIpcClient: () => ({
    request: mocks.cloudRuntimeIpcRequest,
    subscribe: mocks.cloudRuntimeIpcSubscribe,
    dispose: vi.fn(),
  }),
}))

const codexModel = {
  name: 'gpt-5.5',
  type: 'runtime',
  displayName: 'gpt-5.5',
  config: {
    protocol: 'openai-responses',
    weworkModelKind: 'codex-official',
    ui: { family: 'codex-official', modelLabel: 'gpt-5.5' },
  },
  runtime: { family: 'openai.openai-responses' },
  isActive: true,
}

const chatCompletionsModel = {
  name: 'chat-completions-model',
  type: 'public',
  displayName: 'Chat Completions Model',
  config: { protocol: 'openai-chat-completions' },
  runtime: { family: 'openai.openai-chat-completions' },
  isActive: true,
}

const responsesModel = {
  name: 'responses-model',
  type: 'public',
  displayName: 'Responses Model',
  config: { wire_api: 'responses' },
  runtime: { family: 'openai' },
  isActive: true,
}

function createServices() {
  return createHybridWorkbenchServices({
    apiBaseUrl: 'https://cloud.example.com/api',
    socketBaseUrl: 'https://cloud.example.com',
    socketPath: '/socket.io',
    token: 'cloud-token',
  })
}

describe('createHybridWorkbenchServices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.localListRuntimeWork.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })
    mocks.cloudListRuntimeWork.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })
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
    mocks.localListProjects.mockResolvedValue({ items: [] })
    mocks.localUpdateCurrentUser.mockImplementation(async data => data)
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
    mocks.localGetWorktreeSettings.mockResolvedValue({
      deviceId: 'local-device',
      worktreeRoot: '',
      resolvedWorktreeRoot: '/tmp/local-worktrees',
      autoCleanupEnabled: true,
      keepCount: 15,
    })
    mocks.cloudSearchRuntimeWork.mockResolvedValue({ items: [] })
    mocks.cloudRuntimeIpcRequest.mockImplementation(async method => {
      if (method === 'runtime.tasks.list') {
        return { projects: [], chats: [], totalTasks: 0 }
      }
      if (method === 'runtime.tasks.search') {
        return { items: [] }
      }
      return {
        accepted: true,
        deviceId: 'cloud-device',
        taskId: 'cloud-task',
        workspacePath: '/tmp/cloud',
      }
    })
    mocks.localListArchivedConversations.mockResolvedValue({
      items: [],
      projectGroups: [],
      total: 0,
    })
    mocks.cloudListArchivedConversations.mockResolvedValue({
      items: [],
      projectGroups: [],
      total: 0,
    })
    mocks.localArchiveAllConversations.mockResolvedValue({
      accepted: true,
      requestedCount: 0,
      acceptedCount: 0,
      deletedCount: 0,
      results: [],
    })
    mocks.cloudArchiveAllConversations.mockResolvedValue({
      accepted: true,
      requestedCount: 0,
      acceptedCount: 0,
      deletedCount: 0,
      results: [],
    })
    mocks.localArchiveProjectConversations.mockResolvedValue({
      accepted: true,
      requestedCount: 0,
      acceptedCount: 0,
      results: [],
    })
    mocks.cloudArchiveProjectConversations.mockResolvedValue({
      accepted: true,
      requestedCount: 0,
      acceptedCount: 0,
      results: [],
    })
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

  it('loads cloud models in the background without delaying local models', async () => {
    const services = createServices()
    const response = await services.modelApi.listModels()

    expect(response.data.map(model => model.name)).toEqual(['gpt-5.5'])

    await vi.waitFor(async () => {
      const refreshed = await services.modelApi.listModels()
      expect(refreshed.data.map(model => model.name)).toEqual(['gpt-5.5', 'cloud:runtime:gpt-5.5'])
    })
    const refreshed = await services.modelApi.listModels()

    expect(refreshed.data.map(model => model.name)).toEqual(['gpt-5.5', 'cloud:runtime:gpt-5.5'])
    expect(refreshed.data.map(model => getModelExecutionOverride(model)?.modelName)).toEqual([
      'gpt-5.5',
      'gpt-5.5',
    ])
  })

  it('displays cloud models that support Responses, Chat Completions, or Anthropic Messages protocols', async () => {
    mocks.localListModels.mockResolvedValue({ data: [chatCompletionsModel] })
    mocks.cloudListModels.mockResolvedValue({
      data: [chatCompletionsModel, responsesModel],
    })
    const services = createServices()

    await services.modelApi.listModels()
    await vi.waitFor(async () => {
      const refreshed = await services.modelApi.listModels()
      expect(refreshed.data.map(model => model.name)).toEqual([
        'chat-completions-model',
        'cloud:public:chat-completions-model',
        'cloud:public:responses-model',
      ])
    })
    const response = await services.modelApi.listModels()

    expect(response.data.map(model => model.name)).toEqual([
      'chat-completions-model',
      'cloud:public:chat-completions-model',
      'cloud:public:responses-model',
    ])
    expect(getModelExecutionOverride(response.data[1])?.source).toBe('cloud')
    expect(getModelExecutionOverride(response.data[2])?.source).toBe('cloud')
  })

  it('does not wait for an unresponsive cloud model request', async () => {
    mocks.cloudListModels.mockReturnValue(new Promise(() => undefined))
    const services = createServices()

    const response = await services.modelApi.listModels()

    expect(response.data.map(model => model.name)).toEqual(['gpt-5.5'])
    expect(mocks.cloudListModels).toHaveBeenCalledTimes(1)
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

  it('returns remembered cloud devices on the primary device list after background sync', async () => {
    const services = createServices()

    await services.cloudBackgroundApi?.listDevices?.()
    const devices = await services.deviceApi.listDevices()

    expect(devices.map(device => device.device_id)).toEqual(['local-device', 'cloud-device'])
  })

  it('routes Worktree settings to the selected local or cloud device', async () => {
    const services = createServices()
    await services.cloudBackgroundApi?.listDevices?.()

    await services.runtimeWorkApi?.getWorktreeSettings({ deviceId: 'local-device' })
    await services.runtimeWorkApi?.getWorktreeSettings({ deviceId: 'cloud-device' })

    expect(mocks.localGetWorktreeSettings).toHaveBeenCalledWith({ deviceId: 'local-device' })
    expect(mocks.cloudRuntimeIpcRequest).toHaveBeenCalledWith(
      'runtime.worktrees.settings.get',
      { deviceId: 'cloud-device' },
      'cloud-device'
    )
  })

  it('routes cloud device commands through runtime IPC instead of the restricted REST API', async () => {
    mocks.cloudListDevices.mockResolvedValue([
      {
        id: 1,
        device_id: 'cloud-device',
        socket_device_id: 'cloud-runtime-device',
        name: 'Cloud Executor',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
        bind_shell: 'claudecode',
      },
    ])
    mocks.cloudRuntimeIpcRequest.mockResolvedValueOnce({
      success: true,
      exit_code: 0,
      stdout: 'main',
      stderr: '',
    })
    const services = createServices()
    await services.cloudBackgroundApi?.listDevices?.()

    const response = await services.deviceApi.executeCommand('cloud-device', {
      command_key: 'git_branch',
      cwd: '/workspace/cloud',
    })

    expect(response).toEqual({
      success: true,
      exit_code: 0,
      stdout: 'main',
      stderr: '',
    })
    expect(mocks.cloudRuntimeIpcRequest).toHaveBeenCalledWith(
      'device.execute_command',
      { command_key: 'git_branch', cwd: '/workspace/cloud' },
      'cloud-runtime-device'
    )
    expect(mocks.cloudServices.deviceApi.executeCommand).not.toHaveBeenCalled()
  })

  it('resolves an uncached cloud executor before running workspace commands', async () => {
    mocks.cloudListDevices.mockResolvedValue([
      {
        id: 1,
        device_id: '9562a3b4-61a3-4217-9655-0341b231eb06',
        socket_device_id: 'cloud-runtime-device',
        name: 'sifang-executor-0341b231eb06',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
        bind_shell: 'claudecode',
      },
    ])
    mocks.cloudRuntimeIpcRequest.mockResolvedValueOnce({
      success: true,
      exit_code: 0,
      stdout: 'main',
      stderr: '',
    })
    const services = createServices()

    const response = await services.executorClient?.commands.executeCommand(
      '9562a3b4-61a3-4217-9655-0341b231eb06',
      {
        command_key: 'git_branch',
        cwd: '/home/ubuntu/workspace/hello',
      }
    )

    expect(response?.stdout).toBe('main')
    expect(mocks.cloudListDevices).toHaveBeenCalledTimes(1)
    expect(mocks.cloudRuntimeIpcRequest).toHaveBeenCalledWith(
      'device.execute_command',
      {
        command_key: 'git_branch',
        cwd: '/home/ubuntu/workspace/hello',
      },
      'cloud-runtime-device'
    )
  })

  it('merges remembered cloud devices into the local device when app_device_id matches', async () => {
    mocks.cloudListDevices.mockResolvedValue([
      {
        id: 1,
        device_id: 'cloud-device',
        app_device_id: 'local-device',
        name: 'Cloud Executor',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
        bind_shell: 'claudecode',
      },
    ])
    const services = createServices()

    await services.cloudBackgroundApi?.listDevices?.()
    const devices = await services.deviceApi.listDevices()

    expect(devices.map(device => device.device_id)).toEqual(['local-device'])
    expect(devices[0].device_type).toBe('local')
    expect(devices[0].runtime_routes?.map(route => route.kind)).toEqual([
      'local-ipc',
      'cloud-relay',
    ])
    expect(devices[0].runtime_routes?.map(route => route.device_id)).toEqual([
      'local-device',
      'cloud-device',
    ])
  })

  it('does not wait for cloud device or runtime-work reads on the primary path', async () => {
    mocks.cloudListDevices.mockReturnValue(new Promise(() => undefined))
    mocks.cloudListRuntimeWork.mockReturnValue(new Promise(() => undefined))
    mocks.localListRuntimeWork.mockResolvedValue({
      projects: [
        {
          project: { key: 'local', name: 'Local' },
          totalTasks: 0,
          deviceWorkspaces: [],
        },
      ],
      chats: [],
      totalTasks: 0,
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

  it('keeps all shared local reads usable while every cloud read is unresponsive', async () => {
    mocks.cloudListDevices.mockReturnValue(new Promise(() => undefined))
    mocks.cloudListModels.mockReturnValue(new Promise(() => undefined))
    mocks.cloudListArchivedConversations.mockReturnValue(new Promise(() => undefined))
    const services = createServices()

    const [team, models, devices, runtimeWork, search, archives, projects] = await Promise.all([
      services.teamApi.getDefaultWorkbenchTeam(),
      services.modelApi.listModels(),
      services.deviceApi.listDevices(),
      services.runtimeWorkApi?.listRuntimeWork(),
      services.runtimeWorkApi?.searchRuntimeWork({ query: 'local' }),
      services.runtimeWorkApi?.listArchivedConversations(),
      services.projectApi.listProjects(),
    ])

    expect(team.name).toBe('local-wework')
    expect(models.data.map(model => model.name)).toEqual(['gpt-5.5'])
    expect(devices.map(device => device.device_id)).toEqual(['local-device'])
    expect(runtimeWork).toEqual({ projects: [], chats: [], totalTasks: 0 })
    expect(search).toEqual({ items: [] })
    expect(archives).toEqual({ items: [], projectGroups: [], total: 0 })
    expect(projects).toEqual({ items: [] })
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

  it('does not request runtime work from offline cloud devices', async () => {
    mocks.cloudListDevices.mockResolvedValue([
      {
        id: 1,
        device_id: 'cloud-device',
        name: 'Cloud Executor',
        status: 'offline',
        is_default: false,
        device_type: 'cloud',
        bind_shell: 'claudecode',
      },
    ])

    const services = createServices()
    const runtimeWork = await services.cloudBackgroundApi?.listRuntimeWork?.()

    expect(runtimeWork).toEqual({ projects: [], chats: [], totalTasks: 0 })
    expect(mocks.cloudRuntimeIpcRequest).not.toHaveBeenCalled()
  })

  it('rejects an incomplete background runtime work refresh', async () => {
    mocks.cloudRuntimeIpcRequest.mockRejectedValue(new Error('remote runtime unavailable'))

    const services = createServices()

    await expect(services.cloudBackgroundApi?.listRuntimeWork?.()).rejects.toThrow(
      'remote runtime unavailable'
    )
  })

  it('does not request background runtime work from another route on the same runtime instance', async () => {
    mocks.localListDevices.mockResolvedValue([
      {
        id: 0,
        device_id: 'local-device',
        name: 'Local Executor',
        status: 'online',
        is_default: true,
        device_type: 'app',
        bind_shell: 'claudecode',
        runtime_instance_id: 'runtime-shared',
      },
    ])
    mocks.cloudListDevices.mockResolvedValue([
      {
        id: 1,
        device_id: 'remote-device',
        name: 'Remote Executor',
        status: 'online',
        is_default: false,
        device_type: 'remote',
        bind_shell: 'claudecode',
        runtime_instance_id: 'runtime-shared',
      },
    ])

    const services = createServices()
    const runtimeWork = await services.cloudBackgroundApi?.listRuntimeWork?.()

    expect(runtimeWork).toEqual({ projects: [], chats: [], totalTasks: 0 })
    expect(mocks.cloudRuntimeIpcRequest).not.toHaveBeenCalled()
  })

  it('removes current app registration work from background runtime work', async () => {
    mocks.cloudRuntimeIpcRequest.mockResolvedValue({
      projects: [
        {
          project: { key: 'cloud', name: 'Cloud' },
          totalTasks: 1,
          deviceWorkspaces: [
            {
              deviceId: 'cloud-device',
              deviceName: 'Cloud Executor',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/cloud',
              tasks: [
                {
                  taskId: 'cloud-task',
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
          tasks: [
            {
              taskId: 'app-chat',
              workspacePath: '/app-chat',
              title: 'App chat',
              runtime: 'codex',
            },
          ],
        },
      ],
      totalTasks: 3,
    })

    const services = createServices()
    await services.deviceApi.listDevices()
    const runtimeWork = await services.cloudBackgroundApi?.listRuntimeWork?.()

    expect(runtimeWork?.projects.map(project => project.project.key)).toEqual(['cloud'])
    expect(runtimeWork?.chats).toEqual([])
    expect(runtimeWork?.totalTasks).toBe(1)
  })

  it('routes runtime task creation by device source', async () => {
    const services = createServices()
    await services.deviceApi.listDevices()
    mocks.localCreateRuntimeTask.mockResolvedValue({
      accepted: true,
      deviceId: 'local-device',
      taskId: 'local-task',
      workspacePath: '/tmp/local',
    })
    mocks.cloudRuntimeIpcRequest.mockResolvedValueOnce({
      accepted: true,
      deviceId: 'cloud-device',
      taskId: 'cloud-task',
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
    expect(mocks.cloudCreateRuntimeTask).not.toHaveBeenCalled()
    expect(mocks.cloudRuntimeIpcRequest).toHaveBeenCalledWith(
      'runtime.tasks.create',
      expect.objectContaining({ deviceId: 'cloud-device', message: 'cloud' }),
      'cloud-device'
    )
  })

  it('configures the cloud model gateway for cloud device runtime tasks', async () => {
    const services = createServices()
    await services.deviceApi.listDevices()

    await services.runtimeWorkApi?.createRuntimeTask({
      deviceId: 'cloud-device',
      workspacePath: '/tmp/cloud',
      teamId: 1,
      runtime: 'codex',
      message: 'cloud model',
    })

    expect(mocks.captureRuntimeIpcOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudModelGateway: {
          baseUrl: 'https://cloud.example.com/api/runtime-work/llm-responses-proxy',
          apiKey: 'cloud-token',
          mcpUrl: 'https://cloud.example.com/api/mcp/delivery/sse',
        },
        transportLabel: 'Cloud',
      })
    )
  })

  it('discovers a local device before routing task creation', async () => {
    mocks.localListDevices.mockResolvedValue([
      {
        id: 0,
        device_id: 'runtime-local-device',
        name: 'Local Executor',
        status: 'online',
        is_default: true,
        device_type: 'local',
        bind_shell: 'claudecode',
      },
    ])
    mocks.localCreateRuntimeTask.mockResolvedValue({
      accepted: true,
      deviceId: 'runtime-local-device',
      taskId: 'local-task',
      workspacePath: '/tmp/local',
    })
    const services = createServices()

    await services.runtimeWorkApi?.createRuntimeTask({
      deviceId: 'runtime-local-device',
      workspacePath: '/tmp/local',
      teamId: 1,
      runtime: 'codex',
      message: 'local',
    })

    expect(mocks.localListDevices).toHaveBeenCalledTimes(1)
    expect(mocks.localCreateRuntimeTask).toHaveBeenCalledTimes(1)
    expect(mocks.cloudRuntimeIpcRequest).not.toHaveBeenCalled()
  })

  it('routes cloud runtime IPC through socket_device_id when provided', async () => {
    mocks.cloudListDevices.mockResolvedValue([
      {
        id: 1,
        device_id: 'cloud-device',
        socket_device_id: 'socket-device',
        name: 'Cloud Executor',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
        bind_shell: 'claudecode',
      },
    ])
    const services = createServices()

    await services.cloudBackgroundApi?.listDevices?.()
    await services.runtimeWorkApi?.createRuntimeTask({
      deviceId: 'cloud-device',
      workspacePath: '/tmp/cloud',
      teamId: 1,
      runtime: 'codex',
      message: 'cloud',
    })

    expect(mocks.cloudRuntimeIpcRequest).toHaveBeenCalledWith(
      'runtime.tasks.create',
      expect.objectContaining({ deviceId: 'cloud-device' }),
      'socket-device'
    )
  })

  it('returns local archives without waiting for cloud and merges cloud archives later', async () => {
    const localItem = {
      id: 'local-archive',
      taskId: 'local-task',
      title: 'Local archive',
      workspacePath: '/tmp/local',
      deviceId: 'local-device',
      source: 'local' as const,
    }
    const cloudItem = {
      id: 'cloud-archive',
      taskId: 'cloud-task',
      title: 'Cloud archive',
      workspacePath: '/tmp/cloud',
      deviceId: 'cloud-device',
      source: 'cloud' as const,
    }
    mocks.localListArchivedConversations.mockResolvedValue({
      items: [localItem],
      projectGroups: [],
      total: 1,
    })
    mocks.cloudListArchivedConversations.mockResolvedValue({
      items: [cloudItem],
      projectGroups: [],
      total: 1,
    })
    const services = createServices()

    const firstResponse = await services.runtimeWorkApi?.listArchivedConversations()

    expect(firstResponse?.items.map(item => item.id)).toEqual(['local-archive'])
    await vi.waitFor(async () => {
      const refreshed = await services.runtimeWorkApi?.listArchivedConversations()
      expect(refreshed?.items.map(item => item.id)).toEqual(['local-archive', 'cloud-archive'])
    })

    const refreshedResponse = await services.runtimeWorkApi?.listArchivedConversations()

    expect(refreshedResponse?.items.map(item => item.id)).toEqual([
      'local-archive',
      'cloud-archive',
    ])
  })

  it('does not wait for an unresponsive cloud archive request', async () => {
    mocks.localListArchivedConversations.mockResolvedValue({
      items: [
        {
          id: 'local-archive',
          taskId: 'local-task',
          title: 'Local archive',
          workspacePath: '/tmp/local',
          deviceId: 'local-device',
          source: 'local',
        },
      ],
      projectGroups: [],
      total: 1,
    })
    mocks.cloudListArchivedConversations.mockReturnValue(new Promise(() => undefined))
    const services = createServices()

    const response = await services.runtimeWorkApi?.listArchivedConversations()

    expect(response?.items.map(item => item.id)).toEqual(['local-archive'])
  })

  it('completes archive-all and local preferences without waiting for cloud services', async () => {
    mocks.cloudArchiveAllConversations.mockReturnValue(new Promise(() => undefined))
    const services = createServices()

    const archiveResponse = await services.runtimeWorkApi?.archiveAllConversations()
    await services.userApi?.updateCurrentUser({ preferences: { theme: 'dark' } })
    await services.projectApi.listProjects()

    expect(archiveResponse?.accepted).toBe(true)
    expect(mocks.localArchiveAllConversations).toHaveBeenCalledTimes(1)
    expect(mocks.cloudArchiveAllConversations).toHaveBeenCalledTimes(1)
    expect(mocks.localUpdateCurrentUser).toHaveBeenCalledTimes(1)
    expect(mocks.localListProjects).toHaveBeenCalledTimes(1)
  })

  it('isolates local reads and mutations from synchronous cloud failures', async () => {
    mocks.cloudListModels.mockImplementation(() => {
      throw new Error('cloud models failed synchronously')
    })
    mocks.cloudListArchivedConversations.mockImplementation(() => {
      throw new Error('cloud archives failed synchronously')
    })
    mocks.cloudArchiveAllConversations.mockImplementation(() => {
      throw new Error('cloud archive-all failed synchronously')
    })
    const services = createServices()

    const models = await services.modelApi.listModels()
    const archives = await services.runtimeWorkApi?.listArchivedConversations()
    const archiveResponse = await services.runtimeWorkApi?.archiveAllConversations()

    expect(models.data.map(model => model.name)).toEqual(['gpt-5.5'])
    expect(archives).toEqual({ items: [], projectGroups: [], total: 0 })
    expect(archiveResponse?.accepted).toBe(true)
    await vi.waitFor(() => {
      expect(mocks.cloudListModels).toHaveBeenCalledTimes(1)
      expect(mocks.cloudListArchivedConversations).toHaveBeenCalledTimes(1)
      expect(mocks.cloudArchiveAllConversations).toHaveBeenCalledTimes(1)
    })
  })

  it('routes remembered local project keys without relying on a local prefix', async () => {
    mocks.localListRuntimeWork.mockResolvedValue({
      projects: [
        {
          project: { key: 'project-state-key', name: 'Local project' },
          deviceWorkspaces: [],
          totalTasks: 0,
        },
      ],
      chats: [],
      totalTasks: 0,
    })
    const services = createServices()

    await services.runtimeWorkApi?.listRuntimeWork()
    await services.runtimeWorkApi?.archiveProjectConversations({
      runtimeProjectKey: 'project-state-key',
    })

    expect(mocks.localArchiveProjectConversations).toHaveBeenCalledWith({
      runtimeProjectKey: 'project-state-key',
    })
    expect(mocks.cloudArchiveProjectConversations).not.toHaveBeenCalled()
  })

  it('requires bulk archive mutations to use one transport per request', async () => {
    const services = createServices()

    await expect(
      services.runtimeWorkApi?.deleteArchivedConversationsBulk({
        items: [
          { deviceId: 'local-device', taskId: 'local-task' },
          { deviceId: 'cloud-device', taskId: 'cloud-task' },
        ],
      })
    ).rejects.toThrow('must target one source')
  })

  it('returns local search immediately and merges cached cloud results later', async () => {
    const services = createServices()
    mocks.localSearchRuntimeWork.mockResolvedValue({
      items: [
        {
          address: { deviceId: 'local-device', taskId: 'local-task' },
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
    mocks.cloudRuntimeIpcRequest.mockImplementation(async method => {
      if (method !== 'runtime.tasks.search') return { projects: [], chats: [], totalTasks: 0 }
      return {
        items: [
          {
            address: { deviceId: 'cloud-device', taskId: 'cloud-task' },
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
      }
    })

    const firstResponse = await services.runtimeWorkApi?.searchRuntimeWork({
      query: 'result',
      limit: 1,
    })

    expect(firstResponse?.items.map(item => item.title)).toEqual(['Older local result'])
    await vi.waitFor(() =>
      expect(mocks.cloudRuntimeIpcRequest).toHaveBeenCalledWith(
        'runtime.tasks.search',
        { query: 'result', limit: 1 },
        'cloud-device'
      )
    )

    const refreshedResponse = await services.runtimeWorkApi?.searchRuntimeWork({
      query: 'result',
      limit: 1,
    })

    expect(refreshedResponse?.items.map(item => item.title)).toEqual(['Newer cloud result'])
    expect(mocks.cloudSearchRuntimeWork).not.toHaveBeenCalled()
  })

  it('does not wait for unresponsive cloud search', async () => {
    mocks.cloudListDevices.mockReturnValue(new Promise(() => undefined))
    mocks.localSearchRuntimeWork.mockResolvedValue({
      items: [
        {
          address: { deviceId: 'local-device', taskId: 'local-task' },
          runtime: 'codex',
          title: 'Local result',
          snippet: 'local',
          matchStart: 0,
          matchEnd: 5,
          deviceName: 'Local Executor',
          workspacePath: '/tmp/local',
        },
      ],
    })
    const services = createServices()

    const response = await services.runtimeWorkApi?.searchRuntimeWork({ query: 'local' })

    expect(response?.items.map(item => item.title)).toEqual(['Local result'])
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

  it('keeps remote workspace sessions on the connected cloud backend', () => {
    const services = createServices()

    expect(services.workspaceSessionApi).toBe(mocks.cloudWorkspaceSessionApi)
  })
})
