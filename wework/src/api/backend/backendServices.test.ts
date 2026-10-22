import { afterEach, describe, expect, test, vi } from 'vitest'
import { createBackendWorkbenchServices } from './backendServices'
import type { createDeviceApi } from '@/api/devices'

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
  test('saves on the owning runtime through IPC while preserving omitted unsupported fields', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetch)
    const data = {
      deviceId: 'owner-device',
      projectKey: 'owner-key',
      name: 'Saved',
      roots: ['/owner'],
      runtime: 'codex' as const,
    }
    composerMocks.request.mockResolvedValue({ ...data, accepted: true })
    const services = createBackendWorkbenchServices(baseOptions)
    await expect(services.runtimeWorkApi!.upsertLocalRuntimeProject(data)).resolves.toMatchObject({
      accepted: true,
    })
    expect(composerMocks.request).toHaveBeenCalledWith(
      'runtime.projects.upsert_local',
      data,
      'owner-device'
    )
    expect(fetch).not.toHaveBeenCalled()
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

  test('invalidates alias-owned plugin knowledge through device discovery while no editor is mounted', async () => {
    const device = {
      device_id: 'logical',
      socket_device_id: 'relay',
      runtime_instance_id: 'runtime',
      status: 'online',
      device_type: 'remote',
      bind_shell: 'claudecode',
      executor_version: '2.0.21',
    }
    let records = [device]
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
    await (services.deviceApi as ReturnType<typeof createDeviceApi>).getAllDevices()
    const api = services.projectDevicePluginApi!('relay')
    composerMocks.request.mockRejectedValue(
      new Error(
        'runtime_rpc_failed: Unsupported runtime RPC method: runtime.codex.app_server.request'
      )
    )
    await expect(api.readState()).rejects.toMatchObject({ name: 'ProjectPluginsUnsupportedError' })
    records = [{ ...device, status: 'offline' }]
    await (services.deviceApi as ReturnType<typeof createDeviceApi>).getAllDevices()
    records = [device]
    await services.deviceApi.listDevices()
    composerMocks.request.mockResolvedValue({ marketplaces: [] })
    await expect(api.readState()).resolves.toMatchObject({ deviceId: 'relay' })
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

  test('does not submit feedback to the connected Backend by default', () => {
    vi.stubEnv('VITE_WEWORK_FEEDBACK_URL', '')
    const services = createBackendWorkbenchServices(baseOptions)

    expect(services.feedbackApi).toBeUndefined()
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

  test('provides the connected backend attachment API', () => {
    const services = createBackendWorkbenchServices(baseOptions)

    expect(services.attachmentApi?.uploadAttachment).toBeTypeOf('function')
    expect(services.attachmentApi?.deleteAttachment).toBeTypeOf('function')
  })

  test('provides one complete shared workspace API to the desktop host', () => {
    const services = createBackendWorkbenchServices(baseOptions)

    expect(services.sharedWorkspaceApi?.projects.list).toBeTypeOf('function')
    expect(services.sharedWorkspaceApi?.projects.get).toBeTypeOf('function')
    expect(services.sharedWorkspaceApi?.comments.create).toBeTypeOf('function')
    expect(services.sharedWorkspaceApi?.automations.list).toBeTypeOf('function')
    expect(services.sharedWorkspaceApi?.incomingHooks.catalog).toBeTypeOf('function')
    expect(services.sharedWorkspaceApi?.runtimeProfiles.list).toBeTypeOf('function')
    expect(services.sharedWorkspaceApi?.agents.list).toBeTypeOf('function')
    expect(services.workspaceRuntimePort?.bindTask).toBeTypeOf('function')
    expect(services.workspaceRuntimePort?.trackProjectTask).toBeTypeOf('function')
    expect(services.workspaceRuntimePort).not.toHaveProperty('claimNextExecution')
    expect(services.workspaceRuntimePort?.reportExecutionLifecycle).toBeTypeOf('function')
    expect('collaborationApi' in services).toBe(false)
  })
})
