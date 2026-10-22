import { createStandInExecutorApi } from '@/api/standIn'
import {
  createRemoteProjectDevicePluginApi,
  type ProjectDevicePluginApi,
} from '@/api/projectDevicePlugins'
import { requestRunnerSelection, type RunnerSelectionRequest } from '@/lib/runner-selection'
import { getToken } from '@/api/auth'
import { createAgentResourceApi } from '@/api/agentResources'
import { createAttachmentApi } from '@/api/attachments'
import { createDeviceApi } from '@/api/devices'
import { createDeliveryApi } from '@/api/deliveries'
import { createExecutorClientFromApis, type ExecutorTransportKind } from '@/api/executorAccess'
import { createFeedbackApi } from '@/api/feedback'
import { createGitApi } from '@/api/git'
import { createHttpClient } from '@/api/http'
import { createImSessionApi } from '@/api/imSessions'
import { createModelApi } from '@/api/models'
import { createProjectApi } from '@/api/projects'
import { createRuntimeWorkApi } from '@/api/runtimeWork'
import { createRuntimeWorkApiFromIpc } from '@/api/local/localServices'
import { createRuntimeProfileApi } from '@/api/runtimeProfiles'
import { createSkillApi } from '@/api/skills'
import { createTaskApi } from '@/api/tasks'
import { createTeamApi } from '@/api/teams'
import { createUserApi } from '@/api/users'
import { getRuntimeConfig } from '@/config/runtime'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createRemoteTerminalClient } from '@/lib/remote-terminal-socket'
import { createChatStream } from '@/stream/chatStream'
import { createWorkbenchDeviceResolver } from '@/lib/workbench-device'
import type { DeviceInfo } from '@/types/api'
import {
  createCloudRuntimeIpcClient,
  createSocketClient,
  type CloudRuntimeIpcClient,
} from '@wegent/chat-core'
import { createRuntimeComposerApi } from '@wegent/chat-core/runtime-composer-api'
import { buildInstalledPluginProjectCatalog } from '@wegent/collaboration'
import { createProjectChatClient } from '@/api/backend/projectChatSocket'
import { createProjectChatAgentApi } from '@/api/projectChatAgents'
import { createProjectAutomationApi } from '@/api/projectAutomations'
import { createProjectIncomingHookApi } from '@/api/projectIncomingHooks'
import { createPluginApi } from '@/api/plugins'
import {
  createWeworkSharedWorkspaceApi,
  createWeworkWorkspaceRuntimePort,
} from '@/features/collaboration'

export const WEWORK_CLIENT_ORIGIN = 'wework'

export interface BackendWorkbenchServicesOptions {
  apiBaseUrl: string
  feedbackUrl: string
  socketBaseUrl: string
  socketPath: string
  getToken: () => string | null
  redirectOnUnauthorized?: boolean
  transportKind?: ExecutorTransportKind
  runtimeIpc?: CloudRuntimeIpcClient
}

export function createBackendWorkbenchServices(
  options: Partial<BackendWorkbenchServicesOptions> = {}
): WorkbenchServices {
  const runtimeConfig = getRuntimeConfig()
  const apiBaseUrl = options.apiBaseUrl ?? runtimeConfig.apiBaseUrl
  const feedbackUrl = options.feedbackUrl ?? runtimeConfig.feedbackUrl
  const socketBaseUrl = options.socketBaseUrl ?? runtimeConfig.socketBaseUrl
  const socketPath = options.socketPath ?? runtimeConfig.socketPath
  const resolveToken = options.getToken ?? getToken
  const transportKind = options.transportKind ?? 'backend-relay'
  const client = createHttpClient({
    baseUrl: apiBaseUrl,
    getToken: resolveToken,
    redirectOnUnauthorized: options.redirectOnUnauthorized,
  })
  const deviceApi = createDeviceApi(client)
  const projectApi = createProjectApi(client)
  const runtimeWorkApi = createRuntimeWorkApi(client)
  const taskApi = createTaskApi(client)
  const deliveryApi = createDeliveryApi(client)
  const socketClient = createSocketClient({
    socketBaseUrl: () => socketBaseUrl,
    path: socketPath,
    namespace: '/chat',
    getToken: resolveToken,
    auth: { client_origin: WEWORK_CLIENT_ORIGIN },
    logger: console,
  })
  const projectChatClient = createProjectChatClient({
    requestRunnerSelection: request => requestRunnerSelection(request as RunnerSelectionRequest),
    socketBaseUrl,
    socketPath,
    getToken: resolveToken,
  })

  const teamApi = createTeamApi(client)
  const modelApi = createModelApi(client)
  const projectChatAgentApi = createProjectChatAgentApi(client)
  const projectAutomationApi = createProjectAutomationApi(client)
  const runtimeProfileApi = createRuntimeProfileApi(client)
  const projectIncomingHookApi = createProjectIncomingHookApi(client)
  const sharedWorkspaceApi = createWeworkSharedWorkspaceApi({
    client,
    deliveryApi,
    projectAutomationApi,
    projectIncomingHookApi,
    runtimeProfileApi,
    projectChatAgentApi,
  })
  const workspaceRuntimePort = createWeworkWorkspaceRuntimePort(deliveryApi, projectAutomationApi)
  const cloudPluginApi = createPluginApi(client, apiBaseUrl)
  const composerRuntimeIpc =
    options.runtimeIpc ??
    createCloudRuntimeIpcClient({
      socketBaseUrl,
      socketPath,
      getToken: resolveToken,
      clientOrigin: 'wework',
    })
  const projectDevicePluginApis = new Map<string, ProjectDevicePluginApi>()
  const agentResourceApi = createAgentResourceApi(client, deviceId =>
    composerRuntimeIpc.request('runtime.runner.catalog', {}, deviceId)
  )
  let knownDevices: DeviceInfo[] | null = null
  let discoveryRevision = 0
  let lastDiscoveryRevision = 0
  const discoverDevices = deviceApi.listDevices
  const observeDevices: typeof discoverDevices = async options => {
    const revision = ++discoveryRevision
    const devices = await discoverDevices(options)
    if (revision >= lastDiscoveryRevision) {
      lastDiscoveryRevision = revision
      knownDevices = devices
      const resolver = createWorkbenchDeviceResolver(devices)
      projectDevicePluginApis.forEach((api, id) => api.observeDevice?.(resolver.resolve(id)))
    }
    return devices
  }
  deviceApi.listDevices = observeDevices
  deviceApi.getAllDevices = observeDevices
  const ownerRuntimeApis = new Map<string, ReturnType<typeof createRuntimeWorkApiFromIpc>>()
  const ownerRuntimeApi = (deviceId: string) => {
    let api = ownerRuntimeApis.get(deviceId)
    if (!api) {
      api = createRuntimeWorkApiFromIpc(
        (method, params) => composerRuntimeIpc.request(method, params, deviceId),
        async () => deviceId
      )
      ownerRuntimeApis.set(deviceId, api)
    }
    return api
  }
  const listAllRuntimeWork = runtimeWorkApi.listRuntimeWork
  runtimeWorkApi.listRuntimeWork = options =>
    options?.deviceId
      ? ownerRuntimeApi(options.deviceId).listRuntimeWork(options)
      : listAllRuntimeWork(options)
  runtimeWorkApi.upsertLocalRuntimeProject = data =>
    ownerRuntimeApi(data.deviceId).upsertLocalRuntimeProject(data)
  const projectDevicePluginApi = (deviceId: string) => {
    let api = projectDevicePluginApis.get(deviceId)
    if (!api) {
      api = createRemoteProjectDevicePluginApi(deviceId, (method, params) =>
        composerRuntimeIpc.request('runtime.codex.app_server.request', { method, params }, deviceId)
      )
      projectDevicePluginApis.set(deviceId, api)
      if (knownDevices)
        api.observeDevice?.(createWorkbenchDeviceResolver(knownDevices).resolve(deviceId))
    }
    return api
  }
  const pluginApi = {
    async listPlugins(deviceId: string) {
      const response = await cloudPluginApi.listInstalledPlugins(deviceId)
      return buildInstalledPluginProjectCatalog(response.items)
    },
  }

  return {
    agentResourceApi,
    teamApi,
    modelApi,
    skillApi: createSkillApi(client),
    projectApi,
    gitApi: createGitApi(client),
    taskApi,
    deviceApi,
    deliveryApi,
    sharedWorkspaceApi,
    workspaceRuntimePort,
    feedbackApi: feedbackUrl ? createFeedbackApi(feedbackUrl) : undefined,
    projectSpaceApis: {
      cloud: deliveryApi,
      defaultLocation: 'cloud',
    },
    projectSpaceDetailServices: {
      cloud: {
        deliveryApi,
        projectChatClient,
        projectChatAgentApi,
        projectAutomationApi,
        runtimeProfileApi,
        projectIncomingHookApi,
        deviceApi,
        modelApi,
        teamApi,
        pluginApi,
      },
    },
    imSessionApi: createImSessionApi(client),
    runtimeWorkApi,
    standInApi: createStandInExecutorApi((method, payload, deviceId) =>
      composerRuntimeIpc.request(method, payload, deviceId)
    ),
    composerCatalogApi: createRuntimeComposerApi(composerRuntimeIpc, deviceId =>
      cloudPluginApi.listInstalledPlugins(deviceId).then(response => response.items)
    ),
    pluginApi,
    projectDevicePluginApi,
    attachmentApi: createAttachmentApi({
      apiBaseUrl,
      getToken: resolveToken,
    }),
    executorClient: createExecutorClientFromApis({
      transportKind,
      deviceApi,
      runtimeWorkApi,
      reviewApi: {
        loadTurnFileChangesDiff: taskApi.getTurnFileChangesDiff,
      },
    }),
    userApi: createUserApi(client),
    socketClient: {
      ensureConnected: (...args) => socketClient.ensureConnected(...args),
      dispose: () => {
        socketClient.dispose()
        composerRuntimeIpc.dispose()
      },
    },
    async recoverRuntimeConnections() {
      projectDevicePluginApis.forEach(api => api.invalidate?.())
      socketClient.disconnect()
      await socketClient.connect(undefined, true)
    },
    projectChatClient,
    projectChatAgentApi,
    projectAutomationApi,
    runtimeProfileApi,
    projectIncomingHookApi,
    workspaceSessionApi: {
      startProjectTerminal: projectApi.startTerminalSession,
      startProjectCodeServer: projectApi.startCodeServerSession,
      startDeviceTerminal: deviceApi.startTerminal,
      startDeviceCodeServer: deviceApi.startCodeServer,
      startDeviceExtensionSession: deviceApi.startExtensionSession,
      revokeDeviceExtensionSession: deviceApi.revokeExtensionSession,
      createRemoteTerminalClient: sessionId =>
        createRemoteTerminalClient(sessionId, {
          socketBaseUrl,
          socketPath,
          getToken: resolveToken,
        }),
    },
    chatStream: createChatStream(socketClient.socket),
  }
}
