import { afterEach, describe, expect, test, vi } from 'vitest'
import { createBackendWorkbenchServices } from './backendServices'

const composerMocks = vi.hoisted(() => ({ request: vi.fn(), installed: vi.fn(), dispose: vi.fn() }))
vi.mock('@wegent/chat-core', async importOriginal => ({
  ...(await importOriginal<typeof import('@wegent/chat-core')>()),
  createCloudRuntimeIpcClient: () => ({
    request: composerMocks.request,
    dispose: composerMocks.dispose,
  }),
}))
vi.mock('@/api/plugins', () => ({
  createPluginApi: () => ({ listInstalledPlugins: composerMocks.installed }),
}))

const baseOptions = {
  apiBaseUrl: 'https://backend.example.com/api',
  socketBaseUrl: 'https://backend.example.com',
  socketPath: '/socket.io',
  getToken: () => 'token',
}

describe('createBackendWorkbenchServices', () => {
  test('reads task snapshots from the addressed owner runtime without listing other tasks', async () => {
    composerMocks.request.mockResolvedValue({
      success: true,
      task: { taskId: 'task-1', runtime: 'codex', workspacePath: '/owner', running: true },
    })
    const services = createBackendWorkbenchServices(baseOptions)
    const address = { deviceId: 'owner-device', taskId: 'task-1', workspacePath: '/owner' }
    await expect(services.runtimeWorkApi!.getRuntimeTask!(address)).resolves.toMatchObject({
      taskId: 'task-1',
      running: true,
    })
    expect(composerMocks.request).toHaveBeenCalledExactlyOnceWith(
      'runtime.tasks.get',
      address,
      'owner-device'
    )
  })
  test('reads project save confirmation directly from the addressed owner runtime', async () => {
    composerMocks.request.mockResolvedValue({ workspaces: [] })
    const services = createBackendWorkbenchServices(baseOptions)
    await expect(
      services.runtimeWorkApi!.listRuntimeWork({ deviceId: 'owner-device' })
    ).resolves.toMatchObject({ projects: [], chats: [] })
    expect(composerMocks.request).toHaveBeenCalledWith('runtime.tasks.list', {}, 'owner-device')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  test('stops an unmounted-editor plugin install when discovery replaces its owning runtime', async () => {
    let records = [
      {
        device_id: 'logical',
        socket_device_id: 'relay',
        runtime_instance_id: 'old',
        status: 'online',
        device_type: 'remote',
        bind_shell: 'claudecode',
        executor_version: '2.0.21',
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ items: records, total: records.length }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    )
    const services = createBackendWorkbenchServices(baseOptions)
    await services.deviceApi.listDevices()
    const api = services.projectDevicePluginApi!('relay')
    let finishRead!: (value: unknown) => void
    composerMocks.request.mockImplementation(async (_method, params) =>
      params.method === 'plugin/installed'
        ? new Promise(resolve => {
            finishRead = resolve
          })
        : { marketplaces: [] }
    )
    const installing = api.installAvailablePlugin({
      id: 'quality@team',
      name: 'quality',
      manifest: { marketplaceId: 'team', marketplacePath: '/plugins' },
    } as never)
    records = [{ ...records[0], runtime_instance_id: 'replacement' }]
    await services.deviceApi.listDevices()
    finishRead({ marketplaces: [] })
    await expect(installing).rejects.toThrow()
    expect(composerMocks.request).not.toHaveBeenCalledWith(
      'runtime.codex.app_server.request',
      expect.objectContaining({ method: 'plugin/install' }),
      'relay'
    )
    expect(composerMocks.request).not.toHaveBeenCalledWith(
      'runtime.codex.app_server.request',
      expect.objectContaining({ method: 'config/value/write' }),
      'relay'
    )
  })

  test('reads the addressed composer through runtime IPC and disposes its connection', async () => {
    composerMocks.request.mockResolvedValue({
      taskId: 'side-task',
      workspacePath: '/remote',
      projectPluginIds: [],
      apps: [],
      skills: [],
      marketplaces: [],
      store: { storePath: '/store', plugins: [] },
    })
    composerMocks.installed.mockResolvedValue({ items: [] })
    const services = createBackendWorkbenchServices(baseOptions)
    await expect(
      services.composerCatalogApi!.readCatalog(
        { deviceId: 'remote-device', taskId: 'side-task' },
        true
      )
    ).resolves.toMatchObject({ taskId: 'side-task', workspacePath: '/remote' })
    expect(composerMocks.request).toHaveBeenCalledWith(
      'runtime.composer.catalog.read',
      { taskId: 'side-task', forceRefresh: true },
      'remote-device'
    )
    expect(composerMocks.installed).toHaveBeenCalledWith('remote-device')
    services.socketClient!.dispose()
    expect(composerMocks.dispose).toHaveBeenCalledTimes(1)
  })

  test('reads project plugins through the addressed runtime app-server interface', async () => {
    composerMocks.request.mockResolvedValue({ marketplaces: [] })
    const services = createBackendWorkbenchServices(baseOptions)

    await expect(
      services.projectDevicePluginApi!('remote-device').readState()
    ).resolves.toMatchObject({
      deviceId: 'remote-device',
      marketplaceItems: [],
    })

    expect(composerMocks.request).toHaveBeenCalledWith(
      'runtime.codex.app_server.request',
      { method: 'plugin/installed', params: {} },
      'remote-device'
    )
    expect(composerMocks.request).toHaveBeenCalledWith(
      'runtime.codex.app_server.request',
      { method: 'plugin/list', params: { cwds: null } },
      'remote-device'
    )
  })

  test('enables feedback only for the build-time feedback endpoint', () => {
    vi.stubEnv('VITE_WEWORK_FEEDBACK_URL', 'https://feedback.example.com/v1/reports')

    const services = createBackendWorkbenchServices(baseOptions)

    expect(services.feedbackApi).toBeDefined()
  })
})
