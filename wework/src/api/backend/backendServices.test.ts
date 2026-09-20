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
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
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
    expect(services.workspaceRuntimePort?.claimNextExecution).toBeTypeOf('function')
    expect(services.workspaceRuntimePort?.reportExecutionLifecycle).toBeTypeOf('function')
    expect('collaborationApi' in services).toBe(false)
  })
})
