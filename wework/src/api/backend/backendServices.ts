import { getToken } from '@/api/auth'
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
import { createRuntimeProfileApi } from '@/api/runtimeProfiles'
import { createSkillApi } from '@/api/skills'
import { createTaskApi } from '@/api/tasks'
import { createTeamApi } from '@/api/teams'
import { createUserApi } from '@/api/users'
import { getRuntimeConfig } from '@/config/runtime'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createRemoteTerminalClient } from '@/lib/remote-terminal-socket'
import { createChatStream } from '@/stream/chatStream'
import { createSocketClient } from '@wegent/chat-core'
import { createProjectChatClient } from '@/api/backend/projectChatSocket'
import { createProjectChatAgentApi } from '@/api/projectChatAgents'
import { createProjectAutomationApi } from '@/api/projectAutomations'
import { createProjectIncomingHookApi } from '@/api/projectIncomingHooks'
import { createPluginApi } from '@/api/plugins'
import { buildProjectPluginCatalog } from '@/features/plugins/projectPluginCatalog'

export const WEWORK_CLIENT_ORIGIN = 'wework'

export interface BackendWorkbenchServicesOptions {
  apiBaseUrl: string
  feedbackUrl: string
  socketBaseUrl: string
  socketPath: string
  getToken: () => string | null
  redirectOnUnauthorized?: boolean
  transportKind?: ExecutorTransportKind
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
  const cloudPluginApi = createPluginApi(client, apiBaseUrl)
  const pluginApi = {
    async listPlugins(deviceId: string) {
      const response = await cloudPluginApi.listInstalledPlugins(deviceId)
      return buildProjectPluginCatalog(response.items)
    },
  }

  return {
    teamApi,
    modelApi,
    skillApi: createSkillApi(client),
    projectApi,
    gitApi: createGitApi(client),
    taskApi,
    deviceApi,
    deliveryApi,
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
    pluginApi,
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
    socketClient,
    async recoverRuntimeConnections() {
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
