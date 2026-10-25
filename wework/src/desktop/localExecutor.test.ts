import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createLocalAppServices, createRuntimeWorkApiFromIpc } from '@/api/local/localServices'
import { getLocalRuntimeSourceIdentity } from '@/lib/local-runtime-sidebar-identity'
import { updateRuntimeWorkProject } from '@/lib/runtime-project-update'
import { getRuntimeProjectActivation, getRuntimeProjectOwner } from '@/lib/runtime-project-state'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import {
  DshExecutorTransportError,
  describeDshExecutor,
  requestDshExecutor,
  subscribeDshExecutorEvents,
} from '@/api/dsh/executorTransport'
import {
  saveLocalProxyConfig,
  saveLocalProxyUrl,
} from '@/features/model-settings/localProxySettings'
import {
  connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend,
  ensureBundledPluginInstalled,
  withBundledPluginUpdatesPaused,
  resumeBundledPluginUpdates,
  ensureLocalExecutorAvailable,
  ensureLocalExecutorStarted,
  getInitializedBundledPluginMarketplace,
  getBundledPluginUpdateState,
  getKnownLocalExecutorDeviceId,
  getLocalExecutorStatus,
  readLocalExecutorLog,
  requestLocalExecutor,
  resetLocalExecutorStateForTests,
  subscribeLocalExecutorEvents,
} from './localExecutor'

vi.mock('@/api/dsh/executorTransport', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/dsh/executorTransport')>()),
  describeDshExecutor: vi.fn(),
  requestDshExecutor: vi.fn(),
  subscribeDshExecutorEvents: vi.fn(),
}))

const describeDshExecutorMock = vi.mocked(describeDshExecutor)
const requestDshExecutorMock = vi.mocked(requestDshExecutor)
const subscribeDshExecutorEventsMock = vi.mocked(subscribeDshExecutorEvents)

const marketplace = {
  id: 'wework-personal',
  path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
  pluginCount: 1,
  defaultPluginNames: ['smart-app-builder'],
  contentHash: 'abc123',
}

function mockStartup(): void {
  describeDshExecutorMock.mockResolvedValue({
    protocol_version: 1,
    device_id: 'electron-device',
    runtime_instance_id: 'electron-runtime',
    version: '1.8.6',
    capabilities: ['executor.plugins'],
    renderer_methods: ['runtime.*'],
    transports: ['local-endpoint-ndjson'],
  })
  requestDshExecutorMock.mockImplementation(async method => {
    if (method === 'runtime.codex.ensure_started') {
      return { ready: true, started: true, initializeElapsedMs: 37 }
    }
    if (method === 'executor.plugins.initialize_bundled_marketplace') return marketplace
    if (method === 'runtime.codex.plugin.reconcile_bundled_marketplace')
      return { marketplaceName: marketplace.id, action: 'unchanged' }
    if (method === 'runtime.codex.plugin.sync_bundled') return { status: 'ready', updated: false }
    return {}
  })
}

describe('localExecutor', () => {
  beforeEach(() => {
    localStorage.clear()
    delete window.weworkElectronNetwork
    resetLocalExecutorStateForTests()
    describeDshExecutorMock.mockReset()
    requestDshExecutorMock.mockReset()
    subscribeDshExecutorEventsMock.mockReset()
    subscribeDshExecutorEventsMock.mockReturnValue(() => undefined)
    mockStartup()
  })

  test('negotiates bounded transcript transport while accepting an older executor response', async () => {
    const transcript = { messages: [], turns: [], fullContent: false }
    requestDshExecutorMock.mockResolvedValue(transcript)
    expect(await requestLocalExecutor('runtime.tasks.transcript', { taskId: 'task-1' })).toBe(
      transcript
    )
    expect(requestDshExecutorMock).toHaveBeenCalledExactlyOnceWith('runtime.tasks.transcript', {
      taskId: 'task-1',
      transcriptProtocolVersion: 2,
    })
  })

  test('reports executor availability without starting Codex or copying plugins', async () => {
    await expect(ensureLocalExecutorAvailable()).resolves.toEqual({
      running: true,
      ready: true,
      deviceId: 'electron-device',
      runtimeInstanceId: 'electron-runtime',
      version: '1.8.6',
    })

    expect(describeDshExecutorMock).toHaveBeenCalledOnce()
    expect(requestDshExecutorMock).not.toHaveBeenCalled()
    expect(getInitializedBundledPluginMarketplace()).toBeNull()
    expect(getKnownLocalExecutorDeviceId()).toBe('electron-device')
  })

  test('starts the Electron-managed DSH executor and caches its marketplace', async () => {
    await expect(ensureLocalExecutorStarted()).resolves.toEqual({
      running: true,
      ready: true,
      deviceId: 'electron-device',
      runtimeInstanceId: 'electron-runtime',
      codexInitializeElapsedMs: 37,
      version: '1.8.6',
    })
    await ensureBundledPluginInstalled('smart-app-builder')
    expect(getInitializedBundledPluginMarketplace()).toEqual(marketplace)
    expect(requestDshExecutorMock.mock.calls.slice(0, 3)).toEqual([
      ['runtime.codex.runtime_config.update', { proxyUrl: null }],
      ['runtime.codex.ensure_started'],
      ['executor.plugins.initialize_bundled_marketplace'],
    ])
  })

  test('passes the configured proxy into the startup barrier', async () => {
    saveLocalProxyUrl('http://127.0.0.1:7890')

    await ensureLocalExecutorStarted()

    expect(requestDshExecutorMock).toHaveBeenCalledWith('runtime.codex.runtime_config.update', {
      proxyUrl: 'http://127.0.0.1:7890',
    })
  })

  test('passes the system proxy into the startup barrier when no local proxy is configured', async () => {
    window.weworkElectronNetwork = {
      resolveProxy: vi.fn().mockResolvedValue('http://127.0.0.1:7891'),
    }

    await ensureLocalExecutorStarted()

    expect(requestDshExecutorMock).toHaveBeenCalledWith('runtime.codex.runtime_config.update', {
      proxyUrl: 'http://127.0.0.1:7891',
    })
  })

  test('passes no proxy into the startup barrier in direct mode', async () => {
    const resolveProxy = vi.fn().mockResolvedValue('http://127.0.0.1:7891')
    window.weworkElectronNetwork = { resolveProxy }
    saveLocalProxyConfig('direct')

    await ensureLocalExecutorStarted()

    expect(requestDshExecutorMock).toHaveBeenCalledWith('runtime.codex.runtime_config.update', {
      proxyUrl: null,
    })
    expect(resolveProxy).not.toHaveBeenCalled()
  })

  test('reuses the initialized executor status for repeated startup checks', async () => {
    const first = await ensureLocalExecutorStarted()

    await expect(getLocalExecutorStatus()).resolves.toEqual(first)

    expect(describeDshExecutorMock).toHaveBeenCalledOnce()
    // Startup also reconciles the bundled marketplace into Codex (local RPC).
    expect(
      requestDshExecutorMock.mock.calls.filter(
        ([method]) => method === 'runtime.codex.ensure_started'
      )
    ).toHaveLength(1)
  })

  test('refreshes a healthy cached IPC identity and revokes startup state on runtime replacement', async () => {
    await ensureLocalExecutorStarted()
    describeDshExecutorMock.mockResolvedValue({
      protocol_version: 1,
      device_id: 'electron-device',
      runtime_instance_id: 'replacement-runtime',
      version: '1.8.6',
      capabilities: [],
      renderer_methods: [],
      transports: [],
    })
    await expect(ensureLocalExecutorAvailable({ refresh: true })).resolves.toMatchObject({
      runtimeInstanceId: 'replacement-runtime',
      running: true,
      ready: true,
    })
    await ensureLocalExecutorStarted()
    expect(
      requestDshExecutorMock.mock.calls.filter(
        ([method]) => method === 'runtime.codex.ensure_started'
      )
    ).toHaveLength(2)
  })

  test('uses the refreshed plugin route for the same Runtime without restarting Codex', async () => {
    const description = {
      protocol_version: 1,
      device_id: 'electron-device',
      runtime_instance_id: 'electron-runtime',
      version: '1.8.6',
      capabilities: ['executor.plugins'],
      renderer_methods: ['runtime.*'],
      transports: ['local-endpoint-ndjson'],
    }
    describeDshExecutorMock.mockResolvedValue({
      ...description,
      device_route_id: 'app-record-70',
    })
    const started = await ensureLocalExecutorStarted()
    expect(started.deviceRouteId).toBe('app-record-70')
    expect(getKnownLocalExecutorDeviceId()).toBe('electron-device')

    describeDshExecutorMock.mockResolvedValue({
      ...description,
      device_route_id: ' app-record-71 ',
    })
    const refreshed = await ensureLocalExecutorAvailable({ refresh: true })

    expect(refreshed.deviceId).toBe('electron-device')
    expect(refreshed.runtimeInstanceId).toBe('electron-runtime')
    expect(refreshed.deviceRouteId).toBe('app-record-71')
    expect(getKnownLocalExecutorDeviceId()).toBe('electron-device')
    await ensureLocalExecutorStarted()
    expect(
      requestDshExecutorMock.mock.calls.filter(
        ([method]) => method === 'runtime.codex.ensure_started'
      )
    ).toHaveLength(1)
  })

  test('clears an initialized plugin route when a fresh description is no longer registered', async () => {
    const description = await describeDshExecutorMock()
    describeDshExecutorMock.mockResolvedValue({ ...description, device_route_id: 'app-record-70' })
    const started = await ensureLocalExecutorStarted()
    expect(started.deviceRouteId).toBe('app-record-70')

    describeDshExecutorMock.mockResolvedValue(description)
    const refreshed = await ensureLocalExecutorAvailable({ refresh: true })

    expect(refreshed.deviceRouteId).toBeUndefined()
    expect(getKnownLocalExecutorDeviceId()).toBe('electron-device')
  })

  test('retains the local plugin catalog cache across record-route changes and rejects another device', async () => {
    const {
      clearLocalCodexPluginsReadStateCache,
      createLocalCodexPluginApi,
      peekLocalCodexPluginsReadState,
    } = await import('@/api/local/codexPlugins')
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    clearLocalCodexPluginsReadStateCache()
    const description = await describeDshExecutorMock()
    describeDshExecutorMock.mockResolvedValue({ ...description, device_route_id: 'app-record-70' })
    const defaultRequest = requestDshExecutorMock.getMockImplementation()!
    requestDshExecutorMock.mockImplementation(async (...args) => {
      if (args[0] === 'codex.app_server_request') return { marketplaces: [] }
      if (args[0] === 'executor.plugins.links.list') return []
      if (args[0] === 'executor.plugins.store.list') return { storePath: '/tmp/store', plugins: [] }
      return defaultRequest(...args)
    })
    try {
      const params = { mergeAllMarketplaces: true }
      const state = await createLocalCodexPluginApi().readState(params)
      expect(state.deviceId).toBe('electron-device')
      expect(peekLocalCodexPluginsReadState(params)?.deviceId).toBe('electron-device')
      const persisted = localStorage.getItem('wework.plugins.codexCatalog.v1')
      expect(persisted).toBeTruthy()

      describeDshExecutorMock.mockResolvedValue({
        ...description,
        device_route_id: 'app-record-71',
      })
      const refreshed = await ensureLocalExecutorAvailable({ refresh: true })
      expect(refreshed.deviceRouteId).toBe('app-record-71')
      expect(peekLocalCodexPluginsReadState(params)?.deviceId).toBe('electron-device')

      clearLocalCodexPluginsReadStateCache()
      localStorage.setItem('wework.plugins.codexCatalog.v1', persisted!)
      requestDshExecutorMock.mockRejectedValue(new Error('Offline'))
      expect(peekLocalCodexPluginsReadState(params)?.deviceId).toBe('electron-device')

      describeDshExecutorMock.mockResolvedValue({ ...description, device_id: 'another-device' })
      await ensureLocalExecutorAvailable({ refresh: true })
      expect(peekLocalCodexPluginsReadState(params)).toBeNull()
    } finally {
      delete window.__WEWORK_RUNTIME_CONFIG__
      clearLocalCodexPluginsReadStateCache()
    }
  })

  test('rejects a fresh sidebar status check when a cached executor is no longer reachable', async () => {
    await ensureLocalExecutorAvailable()
    describeDshExecutorMock.mockRejectedValueOnce(new Error('IPC offline'))
    await expect(ensureLocalExecutorAvailable({ refresh: true })).rejects.toThrow('IPC offline')
  })

  test('keeps qualified sidebar metadata off the local RPC wire and revalidates before dispatch', async () => {
    const services = createLocalAppServices({ subscribe: () => () => undefined })
    const identity = await services.getLocalRuntimeSidebarIdentity!()
    const request = {
      deviceId: 'electron-device',
      projects: [{ id: 'sidebar-key', hostId: 'remote', remotePath: '/srv/repo' }],
    }
    requestDshExecutorMock.mockClear()
    await services.runtimeWorkApi!.syncRuntimeRemoteProjects(request, {
      localSidebarIdentity: identity!,
    })
    const activation = {
      deviceId: 'electron-device',
      projectKey: 'sidebar-key',
      workspacePath: '/srv/repo',
      remoteHostId: 'remote',
    }
    await services.runtimeWorkApi!.activateRuntimeProject(activation, {
      localSidebarIdentity: identity!,
    })
    expect(requestDshExecutorMock).toHaveBeenCalledWith(
      'runtime.sidebar.projects.activate',
      activation
    )
    expect(requestDshExecutorMock).toHaveBeenCalledWith(
      'runtime.sidebar.projects.sync_remote',
      request
    )
    expect(JSON.stringify(requestDshExecutorMock.mock.calls)).not.toContain('localSidebarIdentity')
    describeDshExecutorMock.mockResolvedValue({
      protocol_version: 1,
      device_id: 'electron-device',
      runtime_instance_id: 'replacement',
      capabilities: [],
      renderer_methods: [],
      transports: [],
    })
    requestDshExecutorMock.mockClear()
    await expect(
      services.runtimeWorkApi!.syncRuntimeRemoteProjects(request, {
        localSidebarIdentity: identity!,
      })
    ).rejects.toThrow('local-sidebar-runtime-changed')
    await expect(
      services.runtimeWorkApi!.activateRuntimeProject(activation, {
        localSidebarIdentity: identity!,
      })
    ).rejects.toThrow('local-sidebar-runtime-changed')
    expect(requestDshExecutorMock).not.toHaveBeenCalled()
  })

  test('does not invent a sidebar owner from missing or offline local IPC status', async () => {
    const missing = createLocalAppServices({ available: async () => ({ running: true }) })
    await expect(missing.getLocalRuntimeSidebarIdentity!()).rejects.toThrow(
      'local-sidebar-identity-unavailable'
    )
    const offline = createLocalAppServices({
      available: async () => ({
        running: false,
        deviceId: 'old-device',
        runtimeInstanceId: 'old-runtime',
      }),
    })
    await expect(offline.getLocalRuntimeSidebarIdentity!()).rejects.toThrow(
      'local-sidebar-executor-offline'
    )
  })

  test('rejects a pure local list when the IPC runtime is replaced during its read', async () => {
    let status = {
      running: true,
      ready: true,
      deviceId: 'electron-device',
      runtimeInstanceId: 'one',
    }
    let resolveList!: (value: unknown) => void
    const request = vi.fn(
      () =>
        new Promise(resolve => {
          resolveList = resolve
        })
    )
    const services = createLocalAppServices({ available: async () => status, request })
    const listing = services.runtimeWorkApi!.listRuntimeWork({ deviceId: 'app-alias' })
    const rejected = expect(listing).rejects.toThrow('local-sidebar-runtime-changed')
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    status = { ...status, runtimeInstanceId: 'replacement' }
    resolveList({ workspaces: [] })
    await rejected
  })

  test.each(['raw', 'normalized'])(
    'binds explicit local APP %s readback to the canonical IPC owner and preserves remote ownership',
    async format => {
      const identity = {
        deviceId: 'electron-device',
        runtimeInstanceId: 'one',
        provenance: 'local-ipc' as const,
      }
      const status = {
        running: true,
        ready: true,
        deviceId: identity.deviceId,
        runtimeInstanceId: identity.runtimeInstanceId,
      }
      const raw = {
        workspaces: [
          {
            workspacePath: '/repo/local',
            projectKey: 'local-key',
            projectSource: 'local_project',
            label: 'Local',
            tasks: [],
          },
          {
            workspacePath: '/srv/remote',
            projectKey: 'legacy-mirror',
            projectSource: 'remote_project',
            workspaceSource: 'remote',
            remoteHostId: 'remote-owner',
            label: 'Remote',
            tasks: [],
          },
        ],
      }
      const response =
        format === 'normalized'
          ? await createRuntimeWorkApiFromIpc(
              vi.fn().mockResolvedValue(raw),
              async () => 'app-alias'
            ).listRuntimeWork()
          : raw
      const request = vi.fn().mockResolvedValue(response)
      const available = vi.fn().mockResolvedValue(status)
      const services = createLocalAppServices({ available, request })
      const aliasWork = await services.runtimeWorkApi!.listRuntimeWork({ deviceId: 'app-alias' })
      const canonicalWork = await services.runtimeWorkApi!.listRuntimeWork()
      expect(request).toHaveBeenCalledWith('runtime.tasks.list', {})
      const native = aliasWork.projects[0]
      const remote = aliasWork.projects[1]
      expect(getRuntimeProjectOwner(native)).toEqual({
        deviceId: identity.deviceId,
        projectKey: 'local-key',
      })
      expect(native.deviceWorkspaces[0].deviceId).toBe(identity.deviceId)
      expect(getLocalRuntimeSourceIdentity(native.deviceWorkspaces[0])).toEqual(identity)
      expect(getLocalRuntimeSourceIdentity(native.project)).toEqual(identity)
      expect(remote.project).toMatchObject({
        stateDeviceId: identity.deviceId,
        ownerDeviceId: 'remote-owner',
      })
      expect(remote.deviceWorkspaces[0]).toMatchObject({
        deviceId: 'remote-owner',
        remoteHostId: 'remote-owner',
      })
      expect(getLocalRuntimeSourceIdentity(remote.deviceWorkspaces[0])).toBeUndefined()
      expect(getLocalRuntimeSourceIdentity(remote.project)).toEqual(identity)
      expect(runtimeProjectUiId(native.project)).toBe(
        runtimeProjectUiId(canonicalWork.projects[0].project)
      )
      const projected = updateRuntimeWorkProject(
        aliasWork,
        {
          deviceId: identity.deviceId,
          projectKey: 'local-key',
          name: 'Saved',
          roots: ['/new-root'],
          aiSettings: null,
          defaultProjectSpace: null,
        },
        [
          {
            id: 1,
            device_id: identity.deviceId,
            runtime_instance_id: identity.runtimeInstanceId,
            device_type: 'local',
            name: 'Local',
            status: 'online',
            is_default: true,
          },
          {
            id: 2,
            device_id: 'remote-owner',
            runtime_instance_id: 'remote-runtime',
            device_type: 'remote',
            name: 'Remote',
            status: 'online',
            is_default: false,
          },
        ]
      )
      expect(projected.projects[0].project.name).toBe('Saved')
      expect(getLocalRuntimeSourceIdentity(projected.projects[0].project)).toEqual(identity)
      const activation = getRuntimeProjectActivation(
        projected,
        runtimeProjectUiId(native.project),
        identity.deviceId,
        [],
        identity
      )
      expect(activation).toEqual({
        deviceId: identity.deviceId,
        projectKey: 'local-key',
        workspacePath: '/new-root',
      })
      await services.runtimeWorkApi!.activateRuntimeProject(activation!, {
        localSidebarIdentity: identity,
      })
      await services.runtimeWorkApi!.removeRuntimeWorkspace({
        deviceId: native.deviceWorkspaces[0].deviceId,
        projectKey: native.project.key,
        workspacePath: native.deviceWorkspaces[0].workspacePath,
        runtime: 'codex',
      })
      expect(request).toHaveBeenCalledWith('runtime.sidebar.projects.activate', activation)
      expect(request).toHaveBeenCalledWith(
        'runtime.workspaces.remove',
        expect.objectContaining({ deviceId: identity.deviceId, projectKey: 'local-key' })
      )
    }
  )

  test('keeps remote IPC adapters without a local source callback unchanged', async () => {
    const request = vi.fn().mockResolvedValue({
      workspaces: [{ workspacePath: '/srv/repo', projectKey: 'remote-key', tasks: [] }],
    })
    const api = createRuntimeWorkApiFromIpc(request, async () => 'remote-default')
    const work = await api.listRuntimeWork({ deviceId: 'remote-alias' })
    expect(work.projects[0].deviceWorkspaces[0].deviceId).toBe('remote-alias')
    expect(getLocalRuntimeSourceIdentity(work.projects[0].project)).toBeUndefined()
    expect(request).toHaveBeenCalledExactlyOnceWith('runtime.tasks.list', {}, 'remote-alias')
  })

  test('does not treat a present but unavailable local list source as a remote adapter', async () => {
    const request = vi.fn().mockResolvedValue({ workspaces: [] })
    const api = createRuntimeWorkApiFromIpc(request, async () => 'local-device', {
      getLocalRuntimeSidebarIdentity: async () => null,
    })
    await expect(api.listRuntimeWork()).rejects.toThrow('local-sidebar-identity-unavailable')
    expect(request).not.toHaveBeenCalled()
  })

  test('revokes service-level cached identity after a malformed fresh IPC description', async () => {
    const unavailable = new DshExecutorTransportError('protocol_mismatch', 'Invalid local identity')
    const available = vi.fn().mockResolvedValue({
      running: true,
      ready: true,
      deviceId: 'old-device',
      runtimeInstanceId: 'old-runtime',
    })
    const request = vi
      .fn()
      .mockResolvedValue({ success: true, exit_code: 0, stdout: '', stderr: '' })
    const services = createLocalAppServices({ available, request })
    await services.getLocalRuntimeSidebarIdentity!()
    available.mockRejectedValue(unavailable)
    await expect(services.getLocalRuntimeSidebarIdentity!()).rejects.toThrow(
      'Invalid local identity'
    )
    await expect(
      services.deviceApi.executeCommand('old-device', { command_key: 'git_branch' })
    ).rejects.toThrow('Invalid local identity')
    expect(request).not.toHaveBeenCalled()
  })

  test('invalidates the initialized status after an executor request failure', async () => {
    await ensureLocalExecutorStarted()
    await ensureBundledPluginInstalled('smart-app-builder')
    requestDshExecutorMock.mockRejectedValueOnce(new Error('executor unavailable'))

    await expect(requestLocalExecutor('runtime.tasks.list')).rejects.toThrow('executor unavailable')
    mockStartup()
    await ensureLocalExecutorStarted()

    expect(describeDshExecutorMock).toHaveBeenCalledTimes(2)
  })

  test('keeps the initialized status after an executor business error', async () => {
    await ensureLocalExecutorStarted()
    await ensureBundledPluginInstalled('smart-app-builder')
    requestDshExecutorMock.mockRejectedValueOnce(
      new DshExecutorTransportError(
        'connector_cloud_disconnected',
        'Connect Wework to Wegent cloud before synchronizing apps'
      )
    )

    await expect(requestLocalExecutor('runtime.connectors.apps.sync')).rejects.toThrow(
      'Connect Wework to Wegent cloud'
    )
    await ensureLocalExecutorStarted()

    expect(describeDshExecutorMock).toHaveBeenCalledOnce()
    expect(
      requestDshExecutorMock.mock.calls.filter(
        ([method]) => method === 'runtime.codex.ensure_started'
      )
    ).toHaveLength(1)
  })

  test('retains validated installation identity while disconnected and replaces it on reconnect', async () => {
    const services = createLocalAppServices({ subscribe: () => () => undefined })
    await services.deviceApi.listDevices()
    const disconnected = new DshExecutorTransportError(
      'executor_disconnected',
      'IPC disconnected',
      true
    )
    requestDshExecutorMock.mockRejectedValueOnce(disconnected)
    await expect(requestLocalExecutor('runtime.tasks.list')).rejects.toThrow('IPC disconnected')
    describeDshExecutorMock.mockRejectedValueOnce(disconnected)

    await expect(getLocalExecutorStatus()).resolves.toMatchObject({
      running: false,
      ready: false,
      deviceId: 'electron-device',
      runtimeInstanceId: 'electron-runtime',
      error: 'IPC disconnected',
    })
    expect(getKnownLocalExecutorDeviceId()).toBe('electron-device')
    describeDshExecutorMock.mockRejectedValueOnce(disconnected)
    await expect(services.deviceApi.listDevices()).resolves.toEqual([
      expect.objectContaining({
        status: 'offline',
        device_id: 'electron-device',
        runtime_instance_id: 'electron-runtime',
      }),
    ])
    describeDshExecutorMock.mockResolvedValueOnce({
      protocol_version: 1,
      device_id: 'electron-device',
      runtime_instance_id: 'replacement-runtime',
      capabilities: [],
      renderer_methods: [],
      transports: [],
    })
    await expect(getLocalExecutorStatus()).resolves.toMatchObject({
      running: true,
      runtimeInstanceId: 'replacement-runtime',
    })
  })

  test('revokes cached installation identity when the IPC protocol is invalid', async () => {
    await ensureLocalExecutorAvailable()
    const mismatch = new DshExecutorTransportError('protocol_mismatch', 'Invalid Runtime identity')
    requestDshExecutorMock.mockRejectedValueOnce(mismatch)
    await expect(requestLocalExecutor('runtime.tasks.list')).rejects.toThrow(
      'Invalid Runtime identity'
    )
    describeDshExecutorMock.mockRejectedValueOnce(mismatch)

    await expect(getLocalExecutorStatus()).rejects.toThrow('Invalid Runtime identity')
    expect(getKnownLocalExecutorDeviceId()).toBeNull()
  })

  test('a pending description cannot restore identity revoked by a protocol error', async () => {
    const originalDescription = await describeDshExecutorMock()
    await ensureLocalExecutorAvailable()
    requestDshExecutorMock.mockRejectedValueOnce(
      new DshExecutorTransportError('transport_disconnected', 'Executor disconnected', true)
    )
    await expect(requestLocalExecutor('runtime.tasks.list')).rejects.toThrow(
      'Executor disconnected'
    )
    let finish!: (value: typeof originalDescription) => void
    describeDshExecutorMock.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve
      })
    )
    const pendingStatus = getLocalExecutorStatus()
    requestDshExecutorMock.mockRejectedValueOnce(
      new DshExecutorTransportError('protocol_mismatch', 'Invalid Runtime identity')
    )
    await expect(requestLocalExecutor('runtime.tasks.list')).rejects.toThrow(
      'Invalid Runtime identity'
    )
    expect(getKnownLocalExecutorDeviceId()).toBeNull()

    const rejectedStatus = expect(pendingStatus).rejects.toMatchObject({
      code: 'protocol_mismatch',
    })
    finish(originalDescription)
    await rejectedStatus
    expect(getKnownLocalExecutorDeviceId()).toBeNull()
    await expect(getLocalExecutorStatus()).resolves.toMatchObject({
      running: true,
      runtimeInstanceId: 'electron-runtime',
    })
  })

  test('a pending startup cannot restore identity revoked by a protocol error', async () => {
    let finish!: (value: { ready: boolean }) => void
    const pending = new Promise<{ ready: boolean }>(resolve => {
      finish = resolve
    })
    const original = requestDshExecutorMock.getMockImplementation()!
    requestDshExecutorMock.mockImplementation((method, params) =>
      method === 'runtime.codex.ensure_started' ? pending : original(method, params)
    )
    const pendingStartup = ensureLocalExecutorStarted()
    await vi.waitFor(() =>
      expect(requestDshExecutorMock).toHaveBeenCalledWith('runtime.codex.ensure_started')
    )
    requestDshExecutorMock.mockRejectedValueOnce(
      new DshExecutorTransportError('protocol_mismatch', 'Invalid Runtime identity')
    )
    await expect(requestLocalExecutor('runtime.tasks.list')).rejects.toThrow(
      'Invalid Runtime identity'
    )
    expect(getKnownLocalExecutorDeviceId()).toBeNull()

    const rejectedStartup = expect(pendingStartup).rejects.toMatchObject({
      code: 'protocol_mismatch',
    })
    finish({ ready: true })
    await rejectedStartup
    expect(getKnownLocalExecutorDeviceId()).toBeNull()
    mockStartup()
    await expect(ensureLocalExecutorStarted()).resolves.toMatchObject({
      running: true,
      runtimeInstanceId: 'electron-runtime',
    })
  })

  test('synchronizes declared bundled plugins even when already configured', async () => {
    await ensureBundledPluginInstalled('smart-app-builder')
    expect(requestDshExecutorMock).toHaveBeenCalledWith('runtime.codex.plugin.sync_bundled', {
      marketplacePath: `${marketplace.path}/.agents/plugins/marketplace.json`,
      pluginName: 'smart-app-builder',
    })
    expect(getBundledPluginUpdateState('smart-app-builder')).toEqual({ status: 'ready' })
  })

  test('startup becomes ready while bundled marketplace initialization is pending', async () => {
    let finish!: (value: typeof marketplace) => void
    const pending = new Promise<typeof marketplace>(resolve => {
      finish = resolve
    })
    const original = requestDshExecutorMock.getMockImplementation()!
    requestDshExecutorMock.mockImplementation((method, params) =>
      method === 'executor.plugins.initialize_bundled_marketplace'
        ? pending
        : original(method, params)
    )
    await expect(ensureLocalExecutorStarted()).resolves.toMatchObject({ ready: true })
    expect(getInitializedBundledPluginMarketplace()).toBeNull()
    finish(marketplace)
    await ensureBundledPluginInstalled('smart-app-builder')
    expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('ready')
  })

  test('concurrent uses share one pending plugin update', async () => {
    let finish!: (value: { status: 'ready'; updated: boolean }) => void
    const pending = new Promise<{ status: 'ready'; updated: boolean }>(resolve => {
      finish = resolve
    })
    const original = requestDshExecutorMock.getMockImplementation()!
    requestDshExecutorMock.mockImplementation((method, params) =>
      method === 'runtime.codex.plugin.sync_bundled' ? pending : original(method, params)
    )
    const first = ensureBundledPluginInstalled('smart-app-builder')
    const second = ensureBundledPluginInstalled('smart-app-builder')
    await vi.waitFor(() =>
      expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('updating')
    )
    finish({ status: 'ready', updated: true })
    await Promise.all([first, second])
    expect(
      requestDshExecutorMock.mock.calls.filter(
        ([method]) => method === 'runtime.codex.plugin.sync_bundled'
      )
    ).toHaveLength(1)
  })

  test('busy updates defer usage and resume only after work finishes', async () => {
    vi.useFakeTimers()
    try {
      let busy = true
      const original = requestDshExecutorMock.getMockImplementation()!
      requestDshExecutorMock.mockImplementation((method, params) =>
        method === 'runtime.codex.plugin.sync_bundled'
          ? Promise.resolve({ status: busy ? 'deferred' : 'ready', updated: !busy })
          : original(method, params)
      )
      await expect(ensureBundledPluginInstalled('smart-app-builder')).rejects.toMatchObject({
        code: 'bundled_plugin_update_deferred',
      })
      busy = false
      await vi.advanceTimersByTimeAsync(2_000)
      expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  test('uninstall cancels deferred retries until an explicit reinstall', async () => {
    vi.useFakeTimers()
    try {
      const original = requestDshExecutorMock.getMockImplementation()!
      requestDshExecutorMock.mockImplementation((method, params) =>
        method === 'runtime.codex.plugin.sync_bundled'
          ? Promise.resolve({ status: 'deferred', updated: false })
          : original(method, params)
      )
      await expect(ensureBundledPluginInstalled('smart-app-builder')).rejects.toMatchObject({
        code: 'bundled_plugin_update_deferred',
      })
      const uninstall = vi.fn().mockResolvedValue(undefined)
      await withBundledPluginUpdatesPaused('smart-app-builder', uninstall)
      const syncCount = requestDshExecutorMock.mock.calls.length
      await vi.advanceTimersByTimeAsync(6_000)
      expect(requestDshExecutorMock.mock.calls).toHaveLength(syncCount)
      expect(getBundledPluginUpdateState('smart-app-builder')).toBeUndefined()
      await expect(ensureBundledPluginInstalled('smart-app-builder')).rejects.toMatchObject({
        code: 'bundled_plugin_uninstalled',
      })
      resumeBundledPluginUpdates('smart-app-builder')
      mockStartup()
      await ensureBundledPluginInstalled('smart-app-builder')
      expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  test.each(['ready', 'deferred'] as const)(
    'uninstall waits for an in-flight %s result and ignores its state',
    async status => {
      let finish!: (result: { status: typeof status; updated: boolean }) => void
      const pending = new Promise<{ status: typeof status; updated: boolean }>(resolve => {
        finish = resolve
      })
      const original = requestDshExecutorMock.getMockImplementation()!
      requestDshExecutorMock.mockImplementation((method, params) =>
        method === 'runtime.codex.plugin.sync_bundled' ? pending : original(method, params)
      )
      const use = ensureBundledPluginInstalled('smart-app-builder')
      const rejectedUse = expect(use).rejects.toMatchObject({ code: 'bundled_plugin_uninstalled' })
      await vi.waitFor(() =>
        expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('updating')
      )
      const uninstall = vi.fn().mockResolvedValue(undefined)
      const completion = withBundledPluginUpdatesPaused('smart-app-builder', uninstall)
      expect(uninstall).not.toHaveBeenCalled()
      finish({ status, updated: status === 'ready' })
      await completion
      await rejectedUse
      expect(uninstall).toHaveBeenCalledOnce()
      expect(getBundledPluginUpdateState('smart-app-builder')).toBeUndefined()
    }
  )

  test('failed uninstall restores deferred upgrade recovery', async () => {
    vi.useFakeTimers()
    try {
      await ensureBundledPluginInstalled('smart-app-builder')
      await expect(
        withBundledPluginUpdatesPaused('smart-app-builder', async () => {
          throw new Error('uninstall failed')
        })
      ).rejects.toThrow('uninstall failed')
      await vi.advanceTimersByTimeAsync(2_000)
      await ensureBundledPluginInstalled('smart-app-builder')
      expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  test('a failed plugin does not block other default plugins', async () => {
    const original = requestDshExecutorMock.getMockImplementation()!
    requestDshExecutorMock.mockImplementation((method, params) => {
      if (method === 'executor.plugins.initialize_bundled_marketplace')
        return Promise.resolve({
          ...marketplace,
          defaultPluginNames: ['smart-app-builder', 'wework-space'],
        })
      if (
        method === 'runtime.codex.plugin.sync_bundled' &&
        (params as { pluginName: string }).pluginName === 'wework-space'
      )
        return Promise.reject(
          new DshExecutorTransportError('bundled_plugin_update_failed', 'cache locked')
        )
      return original(method, params)
    })
    await ensureBundledPluginInstalled('smart-app-builder')
    expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('ready')
    expect(getBundledPluginUpdateState('wework-space')?.status).toBe('failed')
  })

  test('a previous runtime update cannot overwrite a new runtime state', async () => {
    let finish!: (result: { status: 'deferred'; updated: boolean }) => void
    const pending = new Promise<{ status: 'deferred'; updated: boolean }>(resolve => {
      finish = resolve
    })
    const original = requestDshExecutorMock.getMockImplementation()!
    requestDshExecutorMock.mockImplementation((method, params) =>
      method === 'runtime.codex.plugin.sync_bundled' ? pending : original(method, params)
    )
    const oldUse = ensureBundledPluginInstalled('smart-app-builder')
    await vi.waitFor(() =>
      expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('updating')
    )
    resetLocalExecutorStateForTests()
    mockStartup()
    await ensureBundledPluginInstalled('smart-app-builder')
    finish({ status: 'deferred', updated: false })
    await oldUse
    expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('ready')
  })

  test('rejects a plugin that is not installed by default', async () => {
    await expect(ensureBundledPluginInstalled('unknown')).rejects.toThrow(
      'Bundled plugin unknown is not installed by default'
    )
  })

  test('routes executor requests through DSH', async () => {
    requestDshExecutorMock.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })

    await expect(requestLocalExecutor('runtime.tasks.list')).resolves.toEqual({
      projects: [],
      chats: [],
      totalTasks: 0,
    })

    expect(requestDshExecutorMock).toHaveBeenCalledWith('runtime.tasks.list', {})
  })

  test('reports the configured backend connection from DSH', async () => {
    requestDshExecutorMock.mockResolvedValue({
      configured: true,
      connected: true,
      backend_url: 'https://api.example.com',
      socket_url: 'wss://socket.example.com',
    })

    await expect(readLocalExecutorLog()).resolves.toMatchObject({
      backendUrl: 'https://api.example.com',
      socketUrl: 'wss://socket.example.com',
      hasBackendAuthToken: true,
    })

    expect(requestDshExecutorMock).toHaveBeenCalledWith('executor.backend.status', {})
  })

  test('configures and clears the backend connection through DSH', async () => {
    await connectLocalExecutorToBackend({
      backendUrl: 'https://api.example.com',
      socketBaseUrl: 'wss://api.example.com',
      authToken: 'token',
      runtimeAuthToken: 'runtime-token',
      deviceType: 'remote',
    })
    resetLocalExecutorStateForTests()
    mockStartup()
    await disconnectLocalExecutorFromBackend()

    expect(requestDshExecutorMock).toHaveBeenCalledWith('executor.backend.configure', {
      backend_url: 'https://api.example.com',
      socket_url: 'wss://api.example.com',
      auth_token: 'token',
      runtime_auth_token: 'runtime-token',
      device_type: 'remote',
    })
    expect(requestDshExecutorMock).toHaveBeenCalledWith('executor.backend.configure', {})
  })

  test('forwards DSH executor events and disposes the subscription', async () => {
    const dispose = vi.fn()
    let listener: ((event: { event: string; payload: Record<string, unknown> }) => void) | null =
      null
    subscribeDshExecutorEventsMock.mockImplementation(callback => {
      listener = callback
      return dispose
    })
    const handler = vi.fn()

    const unlisten = await subscribeLocalExecutorEvents(handler)
    listener?.({ event: 'runtime.updated', payload: { taskId: 'task-1' } })

    expect(handler).toHaveBeenCalledWith({
      event: 'runtime.updated',
      payload: { taskId: 'task-1' },
    })
    unlisten()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
