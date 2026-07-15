import type { EnvironmentDiffMode, EnvironmentInfoLoadOptions } from '@/api/environment'
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
  LocalDeviceApp,
  IMPrivateSessionListResponse,
  LocalDeviceSkill,
  ModelOptions,
  PluginPathComponent,
  ProjectExecutionMode,
  RuntimeContextUsage,
  ProjectWithTasks,
  RuntimeGoalClearResponse,
  RuntimeGoalCreateInput,
  RuntimeGoalGetResponse,
  RuntimeGoalSetRequest,
  RuntimeGoalSetResponse,
  RuntimeGuidanceRequest,
  RuntimeGlobalIMNotificationUpdateRequest,
  RuntimeRollbackRequest,
  RuntimeIMNotificationSettingsResponse,
  RuntimeSendRequest,
  RuntimeTaskAddress,
  RuntimeTaskForkTarget,
  RuntimeProjectAppearanceRequest,
  RuntimeProjectPinRequest,
  RuntimeProjectReorderRequest,
  RuntimeProjectTaskReorderRequest,
  RuntimeTaskPinRequest,
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
import type { RuntimeTaskReminderState } from './runtimeTaskReminders'
import type { WorkbenchServices } from './workbenchServices'

export type ProjectMutationOptions = {
  refreshWorkLists?: boolean
}

export type ArchiveRuntimeTaskOptions = {
  force?: boolean
}

export type ArchiveRuntimeTaskResult = {
  status: 'archived' | 'dirty_worktree' | 'failed'
}

export type ArchiveRuntimeConversationsResult = ArchiveRuntimeTaskResult

export interface SendCurrentInputOptions {
  codeCommentContexts?: CodeCommentContext[]
  initialGoal?: RuntimeGoalCreateInput | null
  onError?: (error: string) => void
  onRuntimeTaskOptimisticOpen?: (
    address: RuntimeTaskAddress,
    context?: { previousAddress?: RuntimeTaskAddress }
  ) => void
}

export interface CreateTemporaryRuntimeTaskOptions {
  project?: ProjectWithTasks | null
  source?: RuntimeTaskAddress | null
  onError?: (error: string) => void
}

export interface CreateProjectRuntimeTaskOptions {
  project: ProjectWithTasks
  attachments?: Attachment[]
  initialGoal?: RuntimeGoalCreateInput | null
  onError?: (error: string) => void
}

export interface RuntimePaneActionOptions {
  onError?: (error: string) => void
}

export interface RuntimePaneGuidanceResult {
  sent: boolean
  turnId?: string
  code?: string | null
  error?: string | null
}

export interface WorkbenchContextValue {
  services: WorkbenchServices
  state: WorkbenchState
  isStartupReady: boolean
  workspaceFileApi: WorkspaceFileApi
  currentRuntimeTaskRunning: boolean
  runtimeTaskReminders: RuntimeTaskReminderState
  cloudWorkStatus: CloudWorkStatus
  projectChat: {
    models: UnifiedModel[]
    skills: UnifiedSkill[]
    selectedModel: UnifiedModel | null
    selectedModelOptions: ModelOptions
    isModelSelectionReady: boolean
    input: string
    trialTemplates: PluginPathComponent[]
    selectedSkills: SkillRef[]
    attachments: Attachment[]
    uploadingFiles: Map<string, { file: File; progress: number }>
    errors: Map<string, string>
    contextUsage?: RuntimeContextUsage
    isOptionsLocked: boolean
    isAttachmentReadyToSend: boolean
    setSelectedModel: (model: UnifiedModel | null) => void
    setSelectedModelAndOptions?: (model: UnifiedModel, options: ModelOptions) => void
    setSelectedModelOption: (optionId: string, value: string) => void
    getSelectedModel?: () => UnifiedModel | null
    getSelectedModelOptions?: () => ModelOptions
    onBlockedModelSelect: (model: UnifiedModel, message?: string) => void
    setInput: (value: string) => void
    setSelectedSkills: (skills: SkillRef[]) => void
    toggleSkill: (skill: SkillRef) => void
    handleFileSelect: (files: File | File[]) => Promise<void>
    addExistingAttachment: (attachment: Attachment) => void
    removeAttachment: (attachmentId: number) => Promise<void>
    resetAttachments: () => void
    listLocalSkills: () => Promise<LocalDeviceSkill[]>
    listLocalApps: () => Promise<LocalDeviceApp[]>
  }
  upgradingDevices: Record<string, DeviceUpgradeState>
  projectExecutionMode: ProjectExecutionMode
  setProjectExecutionMode: (mode: ProjectExecutionMode) => void
  setWorkbenchError: (error: string | null) => void
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
  openRuntimeTask: (address: RuntimeTaskAddress) => Promise<void>
  searchRuntimeWork: (request: RuntimeWorkSearchRequest) => Promise<RuntimeWorkSearchResponse>
  loadRuntimeTranscriptForPane: RuntimeTranscriptLoader
  subscribeRuntimeTaskStream: (
    address: RuntimeTaskAddress,
    handlers: RuntimeTaskStreamHandlers
  ) => () => void
  renameRuntimeTask: (address: RuntimeTaskAddress, title: string) => Promise<void>
  archiveRuntimeTask: (
    address: RuntimeTaskAddress,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeTaskResult>
  archiveProjectConversations: (
    runtimeProjectKey: string,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeConversationsResult>
  archiveProjectsConversations: (
    runtimeProjectKeys: string[],
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeConversationsResult>
  archiveChatConversations: (
    addresses: RuntimeTaskAddress[],
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeConversationsResult>
  forkCurrentRuntimeTask: (target: RuntimeTaskForkTarget) => Promise<void>
  getRuntimeGoal: (address: RuntimeTaskAddress) => Promise<RuntimeGoalGetResponse>
  setRuntimeGoal: (request: RuntimeGoalSetRequest) => Promise<RuntimeGoalSetResponse>
  clearRuntimeGoal: (address: RuntimeTaskAddress) => Promise<RuntimeGoalClearResponse>
  markRuntimeTaskStarted: (address: RuntimeTaskAddress) => void
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
  reorderRuntimeProjects: (data: RuntimeProjectReorderRequest) => Promise<void>
  setRuntimeProjectPinned: (data: RuntimeProjectPinRequest) => Promise<void>
  setRuntimeProjectAppearance: (data: RuntimeProjectAppearanceRequest) => Promise<void>
  reorderRuntimeProjectTasks: (data: RuntimeProjectTaskReorderRequest) => Promise<void>
  setRuntimeTaskPinned: (data: RuntimeTaskPinRequest) => Promise<void>
  getDeviceHomeDirectory: (deviceId: string) => Promise<string>
  getProjectWorkspaceRoot: (deviceId: string) => Promise<string>
  listDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  createDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  loadEnvironmentInfo: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null,
    options?: EnvironmentInfoLoadOptions
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
  commitAndPushEnvironmentChanges: (
    project: ProjectWithTasks | null,
    message: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  pushEnvironmentChanges: (
    project: ProjectWithTasks | null,
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
  sendRuntimePaneMessage: (
    request: RuntimeSendRequest,
    options?: RuntimePaneActionOptions
  ) => Promise<boolean>
  sendRuntimePaneGuidance: (request: RuntimeGuidanceRequest) => Promise<RuntimePaneGuidanceResult>
  compactRuntimePaneTask: (
    address: RuntimeTaskAddress,
    options?: RuntimePaneActionOptions
  ) => Promise<boolean>
  editLastUserMessage: (request: RuntimeRollbackRequest) => Promise<boolean>
  cancelRuntimePaneTask: (
    address: RuntimeTaskAddress,
    options?: RuntimePaneActionOptions
  ) => Promise<boolean>
  sendCurrentInput: (
    inputOverride?: string,
    options?: SendCurrentInputOptions
  ) => Promise<boolean | RuntimeTaskAddress>
  createTemporaryRuntimeTask: (
    input: string,
    options?: CreateTemporaryRuntimeTaskOptions
  ) => Promise<RuntimeTaskAddress | false>
  createProjectRuntimeTask: (
    input: string,
    options: CreateProjectRuntimeTaskOptions
  ) => Promise<RuntimeTaskAddress | false>
  retryFailedMessage: (messageId: string, messagesOverride?: WorkbenchMessage[]) => Promise<void>
  pauseCurrentResponse: (messagesOverride?: WorkbenchMessage[]) => Promise<void>
  loadTurnFileChangesDiff: (
    subtaskId: string,
    messagesOverride?: WorkbenchMessage[],
    fileChangesOverride?: TurnFileChangesSummary
  ) => Promise<string>
  revertTurnFileChanges: (
    subtaskId: string,
    messagesOverride?: WorkbenchMessage[],
    fileChangesOverride?: TurnFileChangesSummary
  ) => Promise<TurnFileChangesSummary>
}

export type WorkbenchPaneState = Pick<
  WorkbenchState,
  | 'isBootstrapping'
  | 'projects'
  | 'devices'
  | 'runtimeWork'
  | 'standaloneDeviceId'
  | 'standaloneWorkspacePath'
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
