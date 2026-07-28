import { createDeviceApi } from '@/api/devices'
import { createDeliveryApi } from '@/api/deliveries'
import {
  createExecutorClientFromApis,
  type ExecutorClient,
  type ExecutorTransportKind,
} from '@/api/executorAccess'
import { createGitApi } from '@/api/git'
import { createFeedbackApi } from '@/api/feedback'
import { createImSessionApi } from '@/api/imSessions'
import { createBackendWorkbenchServices } from '@/api/backend/backendServices'
import { createCloudProjectSpaceApi } from '@/api/hybrid/cloudProjectSpaceApi'
import { createHybridWorkbenchServices } from '@/api/hybrid/hybridServices'
import { createLocalAppServices } from '@/api/local/localServices'
import { createModelApi } from '@/api/models'
import { createProjectApi } from '@/api/projects'
import { createRuntimeWorkApi } from '@/api/runtimeWork'
import { createSkillApi } from '@/api/skills'
import { createTaskApi } from '@/api/tasks'
import { createTeamApi } from '@/api/teams'
import { createUserApi } from '@/api/users'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { isLocalFirstAppRuntime } from '@/lib/runtime-mode'
import type { RemoteTerminalClientFactory } from '@/lib/remote-terminal-socket'
import { createChatStream } from '@/stream/chatStream'
import type {
  Attachment,
  DeviceInfo,
  ProjectDeviceSessionResponse,
  RuntimeWorkListResponse,
  User,
} from '@/types/api'
import type { DeviceSessionResponse } from '@/types/devices'
import type { WorkspaceFileApi } from '@/types/workspace-files'
import type { AuthenticatedSocketClient } from '@wegent/chat-core'
import type { createExternalIssueApi } from '@/api/local/localDelivery'

export interface WorkspaceSessionApi {
  startProjectTerminal: (projectId: number) => Promise<ProjectDeviceSessionResponse>
  startProjectCodeServer: (projectId: number) => Promise<ProjectDeviceSessionResponse>
  startDeviceTerminal: (deviceId: string, cwd?: string) => Promise<DeviceSessionResponse>
  startDeviceCodeServer: (deviceId: string, cwd?: string) => Promise<DeviceSessionResponse>
  createRemoteTerminalClient: RemoteTerminalClientFactory
}

export type ProjectSpaceLocation = 'local' | 'cloud'
export type DeliveryApi = ReturnType<typeof createDeliveryApi>
export type ExternalIssueApi = ReturnType<typeof createExternalIssueApi>

export interface ProjectSpaceApis {
  local?: DeliveryApi
  cloud?: DeliveryApi
  defaultLocation: ProjectSpaceLocation
}

export interface WorkbenchServices {
  teamApi: ReturnType<typeof createTeamApi>
  modelApi: ReturnType<typeof createModelApi>
  skillApi: ReturnType<typeof createSkillApi>
  projectApi: Omit<ReturnType<typeof createProjectApi>, 'createGitWorkspaceProject'> & {
    createGitWorkspaceProject?: ReturnType<typeof createProjectApi>['createGitWorkspaceProject']
  }
  gitApi?: ReturnType<typeof createGitApi>
  taskApi: Pick<
    ReturnType<typeof createTaskApi>,
    'getTurnFileChangesDiff' | 'revertTurnFileChanges'
  >
  deviceApi: Pick<
    ReturnType<typeof createDeviceApi>,
    | 'listDevices'
    | 'getHomeDirectory'
    | 'getProjectWorkspaceRoot'
    | 'listDirectories'
    | 'createDirectory'
    | 'executeCommand'
    | 'upgradeDevice'
    | 'listSkills'
    | 'listWorkspaceEntries'
    | 'readWorkspaceTextFile'
    | 'readWorkspaceFileChunk'
  > & {
    writeWorkspaceTextFile?: NonNullable<WorkspaceFileApi['writeWorkspaceTextFile']>
    createDockerRemoteDeviceCommand?: ReturnType<
      typeof createDeviceApi
    >['createDockerRemoteDeviceCommand']
  }
  deliveryApi?: DeliveryApi
  feedbackApi?: ReturnType<typeof createFeedbackApi>
  externalIssueApi?: ExternalIssueApi
  projectSpaceApis?: ProjectSpaceApis
  imSessionApi?: ReturnType<typeof createImSessionApi>
  runtimeWorkApi?: ReturnType<typeof createRuntimeWorkApi>
  attachmentApi?: {
    uploadAttachment: (file: File, onProgress?: (progress: number) => void) => Promise<Attachment>
    deleteAttachment?: (attachmentId: number) => Promise<void>
  }
  executorClient?: ExecutorClient
  userApi?: ReturnType<typeof createUserApi>
  socketClient?: Pick<AuthenticatedSocketClient, 'ensureConnected' | 'dispose'>
  workspaceSessionApi?: WorkspaceSessionApi
  chatStream: ReturnType<typeof createChatStream>
  cloudBackgroundApi?: {
    listTeams?: ReturnType<typeof createTeamApi>['listTeams']
    getDefaultWorkbenchTeam?: ReturnType<typeof createTeamApi>['getDefaultWorkbenchTeam']
    listDevices?: () => Promise<DeviceInfo[]>
    listRuntimeWork?: () => Promise<RuntimeWorkListResponse>
  }
}

interface CloudConnectionServicesSnapshot {
  isConnected: boolean
  backendUrl?: string
  apiBaseUrl?: string
  socketBaseUrl?: string
  socketPath?: string
  token: string | null
  user?: User
}

export function createExecutorClientForWorkbenchServices(
  services: WorkbenchServices
): ExecutorClient {
  if (services.executorClient) return services.executorClient
  const transportKind: ExecutorTransportKind = isLocalFirstAppRuntime()
    ? 'local-ipc'
    : 'backend-relay'
  if (!services.runtimeWorkApi) {
    throw new Error('Runtime work API is unavailable')
  }
  return createExecutorClientFromApis({
    transportKind,
    deviceApi: services.deviceApi,
    runtimeWorkApi: services.runtimeWorkApi,
    reviewApi: {
      loadTurnFileChangesDiff: services.taskApi.getTurnFileChangesDiff,
    },
  })
}

export function createDefaultWorkbenchServices(
  cloudConnection?: CloudConnectionServicesSnapshot
): WorkbenchServices {
  if (isLocalFirstAppRuntime()) {
    if (
      cloudConnection?.isConnected &&
      cloudConnection.backendUrl &&
      cloudConnection.apiBaseUrl &&
      cloudConnection.socketBaseUrl &&
      cloudConnection.socketPath &&
      cloudConnection.token
    ) {
      return createHybridWorkbenchServices({
        apiBaseUrl: cloudConnection.apiBaseUrl,
        socketBaseUrl: cloudConnection.socketBaseUrl,
        socketPath: cloudConnection.socketPath,
        token: cloudConnection.token,
        user: cloudConnection.user,
      })
    }
    return createLocalAppServices({ user: cloudConnection?.user })
  }

  const cloudServices = createBackendWorkbenchServices()
  if (!isTauriRuntime()) return cloudServices

  const localServices = createLocalAppServices({ user: cloudConnection?.user })
  const cloudProjectSpaceApi = createCloudProjectSpaceApi(
    cloudServices.deliveryApi!,
    localServices.externalIssueApi!
  )
  return {
    ...cloudServices,
    externalIssueApi: localServices.externalIssueApi,
    projectSpaceApis: {
      local: localServices.deliveryApi,
      cloud: cloudProjectSpaceApi,
      defaultLocation: 'cloud',
    },
  }
}
