import type { EnvironmentDiffMode } from '@/api/environment'
import type {
  Attachment,
  BindRuntimeTaskIMSessionsResponse,
  CreateGitWorkspaceProjectRequest,
  CreateProjectRequest,
  DeleteDeviceWorkspaceRequest,
  DeviceWorkspacePrepareRequest,
  DeviceWorkspacePrepareResponse,
  GitBranch,
  GitRepoInfo,
  IMPrivateSessionListResponse,
  LocalDeviceSkill,
  ModelOptions,
  ProjectExecutionMode,
  ProjectWithTasks,
  RuntimeGlobalIMNotificationUpdateRequest,
  RuntimeIMNotificationSettingsResponse,
  RuntimeSendRequest,
  RuntimeTaskAddress,
  RuntimeTaskForkTarget,
  RuntimeTaskIMNotificationSubscriptionRequest,
  RuntimeTaskIMNotificationSubscriptionResponse,
  RuntimeWorkSearchRequest,
  RuntimeWorkSearchResponse,
  SkillRef,
  TurnFileChangesSummary,
  UnifiedModel,
  UnifiedSkill,
  User,
} from '@/types/api'
import type { DeviceUpgradeState } from '@/types/device-events'
import type { DockerRemoteDeviceCommandResponse } from '@/types/devices'
import type { EnvironmentInfo } from '@/types/environment'
import type { CodeCommentContext, WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import type {
  CloudWorkStatus,
  RuntimeTranscriptLoader,
  WorkbenchMessage,
  WorkbenchState,
} from '@/types/workbench'
import type { ReactNode } from 'react'
import type { RuntimeTaskStreamHandlers } from './runtimePaneMessages'
import type { WorkbenchServices } from './workbenchServices'

export type ProjectMutationOptions = {
  refreshWorkLists?: boolean
}

export interface SendCurrentInputOptions {
  codeCommentContexts?: CodeCommentContext[]
  onRuntimeTaskOptimisticOpen?: (address: RuntimeTaskAddress) => void
}

export interface WorkbenchContextValue {
  state: WorkbenchState
  isStartupReady: boolean
  workspaceFileApi: WorkspaceFileApi
  currentRuntimeTaskRunning: boolean
  cloudWorkStatus: CloudWorkStatus
  projectChat: {
    models: UnifiedModel[]
    skills: UnifiedSkill[]
    selectedModel: UnifiedModel | null
    selectedModelOptions: ModelOptions
    isModelSelectionReady: boolean
    selectedSkills: SkillRef[]
    attachments: Attachment[]
    uploadingFiles: Map<string, { file: File; progress: number }>
    errors: Map<string, string>
    isOptionsLocked: boolean
    isAttachmentReadyToSend: boolean
    setSelectedModel: (model: UnifiedModel | null) => void
    setSelectedModelOption: (optionId: string, value: string) => void
    onBlockedModelSelect: (model: UnifiedModel, message?: string) => void
    setSelectedSkills: (skills: SkillRef[]) => void
    toggleSkill: (skill: SkillRef) => void
    handleFileSelect: (files: File | File[]) => Promise<void>
    addExistingAttachment: (attachment: Attachment) => void
    removeAttachment: (attachmentId: number) => Promise<void>
    resetAttachments: () => void
    listLocalSkills: () => Promise<LocalDeviceSkill[]>
  }
  upgradingDevices: Record<string, DeviceUpgradeState>
  projectExecutionMode: ProjectExecutionMode
  setProjectExecutionMode: (mode: ProjectExecutionMode) => void
  projectWorktreeBranch: string | null
  setProjectWorktreeBranch: (branchName: string | null) => void
  selectProject: (projectId: number | null) => void
  selectProjectWorkspace: (projectId: number, deviceWorkspaceId: number | null) => void
  selectStandaloneDevice: (deviceId: string | null) => void
  openStandaloneWorkspace: (
    deviceId: string,
    workspacePath: string,
    label?: string
  ) => Promise<void>
  startNewChat: () => void
  startStandaloneChat: () => void
  startNewProjectChat: (projectId: number) => void
  openRuntimeLocalTask: (address: RuntimeTaskAddress) => Promise<void>
  searchRuntimeWork: (request: RuntimeWorkSearchRequest) => Promise<RuntimeWorkSearchResponse>
  loadRuntimeTranscriptForPane: RuntimeTranscriptLoader
  subscribeRuntimeTaskStream: (
    address: RuntimeTaskAddress,
    handlers: RuntimeTaskStreamHandlers
  ) => () => void
  renameRuntimeLocalTask: (address: RuntimeTaskAddress, title: string) => Promise<void>
  archiveRuntimeLocalTask: (address: RuntimeTaskAddress) => Promise<void>
  archiveProjectConversations: (runtimeProjectKey: string) => Promise<void>
  archiveProjectsConversations: (runtimeProjectKeys: string[]) => Promise<void>
  archiveChatConversations: (addresses: RuntimeTaskAddress[]) => Promise<void>
  forkCurrentRuntimeTask: (target: RuntimeTaskForkTarget) => Promise<void>
  listImPrivateSessions: () => Promise<IMPrivateSessionListResponse>
  bindRuntimeTaskToImSessions: (
    address: RuntimeTaskAddress,
    sessionKeys: string[]
  ) => Promise<BindRuntimeTaskIMSessionsResponse>
  getImNotificationSettings: () => Promise<RuntimeIMNotificationSettingsResponse>
  updateGlobalImNotification: (
    data: RuntimeGlobalIMNotificationUpdateRequest
  ) => Promise<RuntimeIMNotificationSettingsResponse>
  subscribeRuntimeTaskNotifications: (
    data: RuntimeTaskIMNotificationSubscriptionRequest
  ) => Promise<RuntimeTaskIMNotificationSubscriptionResponse>
  unsubscribeRuntimeTaskNotifications: (
    address: RuntimeTaskAddress
  ) => Promise<RuntimeTaskIMNotificationSubscriptionResponse>
  rememberExecutionDevice: (deviceId: string) => void
  refreshWorkLists: () => Promise<void>
  refreshDevices: () => Promise<void>
  getRemoteDeviceStartupCommand: () => Promise<DockerRemoteDeviceCommandResponse>
  upgradeDevice: (deviceId: string) => Promise<void>
  createProject: (
    data: CreateProjectRequest,
    options?: ProjectMutationOptions
  ) => Promise<ProjectWithTasks>
  createGitWorkspaceProject: (data: CreateGitWorkspaceProjectRequest) => Promise<ProjectWithTasks>
  prepareDeviceWorkspace: (
    data: DeviceWorkspacePrepareRequest,
    options?: ProjectMutationOptions
  ) => Promise<DeviceWorkspacePrepareResponse>
  deleteDeviceWorkspace: (data: DeleteDeviceWorkspaceRequest) => Promise<void>
  listGitRepositories: () => Promise<GitRepoInfo[]>
  listGitBranches: (repo: GitRepoInfo) => Promise<GitBranch[]>
  updateProjectName: (projectId: number, name: string) => Promise<void>
  removeProject: (projectId: number) => Promise<void>
  getDeviceHomeDirectory: (deviceId: string) => Promise<string>
  getProjectWorkspaceRoot: (deviceId: string) => Promise<string>
  listDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  createDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  loadEnvironmentInfo: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<EnvironmentInfo>
  loadEnvironmentDiff: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null,
    mode?: EnvironmentDiffMode
  ) => Promise<string>
  commitEnvironmentChanges: (
    project: ProjectWithTasks | null,
    message: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  listEnvironmentBranches: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<string[]>
  checkoutEnvironmentBranch: (
    project: ProjectWithTasks | null,
    branchName: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  createEnvironmentBranch: (
    project: ProjectWithTasks | null,
    branchName: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  sendRuntimePaneMessage: (request: RuntimeSendRequest) => Promise<boolean>
  cancelRuntimePaneTask: (address: RuntimeTaskAddress) => Promise<boolean>
  sendCurrentInput: (
    inputOverride?: string,
    options?: SendCurrentInputOptions
  ) => Promise<boolean | RuntimeTaskAddress>
  retryFailedMessage: (messageId: string, messagesOverride?: WorkbenchMessage[]) => Promise<void>
  pauseCurrentResponse: (messagesOverride?: WorkbenchMessage[]) => Promise<void>
  loadTurnFileChangesDiff: (
    turnId: number,
    messagesOverride?: WorkbenchMessage[]
  ) => Promise<string>
  revertTurnFileChanges: (
    turnId: number,
    messagesOverride?: WorkbenchMessage[]
  ) => Promise<TurnFileChangesSummary>
}

export type WorkbenchPaneState = Pick<
  WorkbenchState,
  | 'isBootstrapping'
  | 'projects'
  | 'devices'
  | 'runtimeWork'
  | 'standaloneDeviceId'
  | 'selectedDeviceWorkspaceId'
  | 'pendingProjectWorkspaceProjectId'
  | 'user'
  | 'error'
>

export type WorkbenchPaneContextValue = Omit<
  WorkbenchContextValue,
  'state' | 'currentRuntimeTaskRunning' | 'cloudWorkStatus'
> & {
  state: WorkbenchPaneState
}

export interface WorkbenchProviderProps {
  children: ReactNode
  user: User
  services?: WorkbenchServices
  onStartupReadyChange?: (ready: boolean) => void
}
