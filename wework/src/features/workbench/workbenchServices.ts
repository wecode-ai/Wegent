import { createDeviceApi } from '@/api/devices'
import { createDeliveryApi } from '@/api/deliveries'
import type { AITableApi } from '@/api/aitable'
import type { DwsApi } from '@/api/dws'
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
import type {
  createLocalLoopItemExecutionApi,
  createLocalProjectChatAgentApi,
} from '@/api/local/localDelivery'
import { createRuntimeWorkApi } from '@/api/runtimeWork'
import { createSkillApi } from '@/api/skills'
import { createTaskApi } from '@/api/tasks'
import { createTeamApi } from '@/api/teams'
import { createUserApi } from '@/api/users'
import { getRuntimeConfig } from '@/config/runtime'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { isLocalFirstAppRuntime } from '@/lib/runtime-mode'
import type { RemoteTerminalClientFactory } from '@/lib/remote-terminal-socket'
import { createChatStream } from '@/stream/chatStream'
import type { Attachment, ProjectDeviceSessionResponse, User } from '@/types/api'
import type { DeviceSessionResponse } from '@/types/devices'
import type {
  Automation,
  AutomationListResponse,
  AutomationMutation,
  AutomationRun,
  AutomationRunListResponse,
} from '@/types/automation'
import type { WorkspaceFileApi } from '@/types/workspace-files'
import type { AuthenticatedSocketClient } from '@wegent/chat-core'
import type { createExternalIssueApi } from '@/api/local/localDelivery'
import type { ProjectChatClient } from '@/api/backend/projectChatSocket'
import type { createProjectChatAgentApi } from '@/api/projectChatAgents'
import type {
  LocalHarnessModelLaunchConfig,
  LocalHarnessModelOption,
} from '@/features/local-harness/localHarnessModels'
import type { LocalHarnessId } from '@/lib/local-harness'
import type { createProjectAutomationApi } from '@/api/projectAutomations'
import type { createProjectIncomingHookApi } from '@/api/projectIncomingHooks'

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

export interface ProjectSpaceDetailServices {
  deliveryApi: DeliveryApi
  projectChatClient?: ProjectChatClient
  projectChatAgentApi?: ReturnType<typeof createProjectChatAgentApi>
  projectAutomationApi?: ReturnType<typeof createProjectAutomationApi>
  projectIncomingHookApi?: ReturnType<typeof createProjectIncomingHookApi>
  loopItemExecutionApi?: ReturnType<typeof createLocalLoopItemExecutionApi>
  deviceApi: WorkbenchServices['deviceApi']
  modelApi: WorkbenchServices['modelApi']
  teamApi: WorkbenchServices['teamApi']
}

export interface ProjectSpaceDetailServiceMap {
  local?: ProjectSpaceDetailServices
  cloud?: ProjectSpaceDetailServices
}

export interface AutomationApi {
  listAutomations: () => Promise<AutomationListResponse>
  getAutomation: (automationId: string) => Promise<{ automation: Automation }>
  createAutomation: (data: AutomationMutation) => Promise<{ automation: Automation }>
  updateAutomation: (
    automationId: string,
    data: AutomationMutation
  ) => Promise<{ automation: Automation }>
  deleteAutomation: (automationId: string) => Promise<{ deleted: boolean }>
  toggleAutomation: (automationId: string, enabled: boolean) => Promise<{ automation: Automation }>
  runAutomationNow: (automationId: string) => Promise<{ run: AutomationRun | null }>
  listAutomationRuns: (automationId?: string) => Promise<AutomationRunListResponse>
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
    | 'getRuntimeSettings'
    | 'updateRuntimeSettings'
    | 'getHomeDirectory'
    | 'getProjectWorkspaceRoot'
    | 'listDirectories'
    | 'createDirectory'
    | 'executeCommand'
    | 'upgradeDevice'
    | 'listSkills'
  > & {
    listWorkspaceEntries: WorkspaceFileApi['listWorkspaceEntries']
    readWorkspaceTextFile: WorkspaceFileApi['readWorkspaceTextFile']
    readWorkspaceFileChunk: NonNullable<WorkspaceFileApi['readWorkspaceFileChunk']>
    writeWorkspaceTextFile?: NonNullable<WorkspaceFileApi['writeWorkspaceTextFile']>
    createDockerRemoteDeviceCommand?: ReturnType<
      typeof createDeviceApi
    >['createDockerRemoteDeviceCommand']
  }
  deliveryApi?: DeliveryApi
  feedbackApi?: ReturnType<typeof createFeedbackApi>
  aitableApi?: AITableApi
  dwsApi?: DwsApi
  externalIssueApi?: ExternalIssueApi
  projectSpaceApis?: ProjectSpaceApis
  projectSpaceDetailServices?: ProjectSpaceDetailServiceMap
  imSessionApi?: ReturnType<typeof createImSessionApi>
  runtimeWorkApi?: ReturnType<typeof createRuntimeWorkApi>
  automationApi?: AutomationApi
  attachmentApi?: {
    uploadAttachment: (file: File, onProgress?: (progress: number) => void) => Promise<Attachment>
    deleteAttachment?: (attachmentId: number) => Promise<void>
    uploadLocalAttachmentToCloud?: (attachment: Attachment) => Promise<Attachment>
  }
  executorClient?: ExecutorClient
  userApi?: ReturnType<typeof createUserApi>
  socketClient?: Pick<AuthenticatedSocketClient, 'ensureConnected' | 'dispose'>
  projectChatClient?: ProjectChatClient
  localProjectChatClient?: ProjectChatClient
  projectChatAgentApi?: ReturnType<typeof createProjectChatAgentApi>
  projectAutomationApi?: ReturnType<typeof createProjectAutomationApi>
  projectIncomingHookApi?: ReturnType<typeof createProjectIncomingHookApi>
  localProjectChatAgentApi?: ReturnType<typeof createLocalProjectChatAgentApi>
  localLoopItemExecutionApi?: ReturnType<typeof createLocalLoopItemExecutionApi>
  localHarnessModelApi?: {
    resolveLaunch: (
      harnessId: LocalHarnessId,
      option: LocalHarnessModelOption | null
    ) => Promise<LocalHarnessModelLaunchConfig | null>
    unregisterProxy: (token: string) => Promise<void>
    unregisterContext: (token: string) => Promise<void>
  }
  workspaceSessionApi?: WorkspaceSessionApi
  chatStream: ReturnType<typeof createChatStream>
  cloudBackgroundApi?: {
    listTeams?: ReturnType<typeof createTeamApi>['listTeams']
    getDefaultWorkbenchTeam?: ReturnType<typeof createTeamApi>['getDefaultWorkbenchTeam']
    listDevices?: ReturnType<typeof createDeviceApi>['listDevices']
    listRuntimeWork?: ReturnType<typeof createRuntimeWorkApi>['listRuntimeWork']
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

function withConfiguredFeedbackApi(services: WorkbenchServices): WorkbenchServices {
  const feedbackUrl = getRuntimeConfig().feedbackUrl
  return feedbackUrl ? { ...services, feedbackApi: createFeedbackApi(feedbackUrl) } : services
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
      return withConfiguredFeedbackApi(
        createHybridWorkbenchServices({
          backendUrl: cloudConnection.backendUrl,
          apiBaseUrl: cloudConnection.apiBaseUrl,
          socketBaseUrl: cloudConnection.socketBaseUrl,
          socketPath: cloudConnection.socketPath,
          token: cloudConnection.token,
          user: cloudConnection.user,
        })
      )
    }
    return withConfiguredFeedbackApi(createLocalAppServices({ user: cloudConnection?.user }))
  }

  const cloudServices = createBackendWorkbenchServices()
  if (!isTauriRuntime()) return cloudServices

  const localServices = createLocalAppServices({ user: cloudConnection?.user })
  const cloudProjectSpaceApi = createCloudProjectSpaceApi(cloudServices.deliveryApi!)
  return {
    ...cloudServices,
    aitableApi: localServices.aitableApi,
    dwsApi: localServices.dwsApi,
    externalIssueApi: localServices.externalIssueApi,
    projectSpaceApis: {
      local: localServices.deliveryApi,
      cloud: cloudProjectSpaceApi,
      defaultLocation: 'cloud',
    },
    projectSpaceDetailServices: {
      local: localServices.projectSpaceDetailServices?.local,
      cloud: cloudServices.projectSpaceDetailServices?.cloud,
    },
  }
}
