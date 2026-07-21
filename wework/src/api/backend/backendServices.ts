import { getToken } from '@/api/auth'
import { createDeviceApi } from '@/api/devices'
import { createExecutorClientFromApis, type ExecutorTransportKind } from '@/api/executorAccess'
import { createGitApi } from '@/api/git'
import { createHttpClient } from '@/api/http'
import { createImSessionApi } from '@/api/imSessions'
import { createModelApi } from '@/api/models'
import { createProjectApi } from '@/api/projects'
import { createRuntimeWorkApi } from '@/api/runtimeWork'
import { createSkillApi } from '@/api/skills'
import { createTaskApi } from '@/api/tasks'
import { createTeamApi } from '@/api/teams'
import { createUserApi } from '@/api/users'
import { getRuntimeConfig } from '@/config/runtime'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createRemoteTerminalClient } from '@/lib/remote-terminal-socket'
import { createChatStream } from '@/stream/chatStream'
import { createSocketClient } from '@wegent/chat-core'

export const WEWORK_CLIENT_ORIGIN = 'wework'

export interface BackendWorkbenchServicesOptions {
  apiBaseUrl: string
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
  const socketClient = createSocketClient({
    socketBaseUrl: () => socketBaseUrl,
    path: socketPath,
    namespace: '/chat',
    getToken: resolveToken,
    auth: { client_origin: WEWORK_CLIENT_ORIGIN },
    logger: console,
  })

  return {
    teamApi: createTeamApi(client),
    modelApi: createModelApi(client),
    skillApi: createSkillApi(client),
    projectApi,
    gitApi: createGitApi(client),
    taskApi,
    deviceApi,
    imSessionApi: createImSessionApi(client),
    runtimeWorkApi,
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
