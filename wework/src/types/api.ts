import type {
  InstalledPluginComponents,
  PluginInterface,
  InstalledPlugin,
} from '@wegent/chat-core/installed-plugin-types'
export type {
  PluginInstallState,
  PluginSkillComponent,
  PluginMCPComponent,
  InstalledPluginComponents,
  WorkbenchFrontendModule,
  WorkbenchDesktopSidecar,
  WorkbenchPluginComponent,
  PluginLocalAuthDefinition,
  PluginLocalAuthArtifactDefinition,
  PluginLocalAuthToolDefinition,
  InstalledPluginSource,
  InstalledPluginPackageRef,
  PluginInterface,
  InstalledPlugin,
} from '@wegent/chat-core/installed-plugin-types'
import type { LocalDeviceSkill } from '@wegent/chat-core/runtime-composer-catalog'
export type {
  LocalDeviceSkill,
  LocalDeviceApp,
  PluginPathComponent,
} from '@wegent/chat-core/runtime-composer-catalog'
import type {
  ProjectGitConfig,
  ProjectConfig,
  ProjectWithTasks,
  RuntimeWorktreeCapability,
} from '@wegent/chat-core/execution-project'
export type {
  ProjectExecutionConfig,
  ProjectWorkspaceConfig,
  ProjectGitConfig,
  ProjectConfig,
  DeviceInfo,
  DeviceRuntimeRoute,
  DeviceRunningTask,
  ProjectTask,
  ProjectWithTasks,
  RuntimeWorktreeCapability,
  RuntimeInteractiveSessionCapability,
  RuntimeFeatureSet,
  DeviceRuntimeRouteKind,
} from '@wegent/chat-core/execution-project'
import type { RuntimeTaskCreateIntent } from '@wegent/chat-core/runtime-task-api-types'
export type { RuntimeTaskCreateResponse } from '@wegent/chat-core/runtime-task-api-types'
import type { RuntimeTaskCancelResponse } from '@wegent/chat-core/runtime-task-api-types'
export type { RuntimeTaskCancelResponse } from '@wegent/chat-core/runtime-task-api-types'
import type {
  RuntimeProjectSpaceRef,
  RuntimeProjectAiSettings,
  RuntimeProjectPluginRef,
  RuntimeProjectAppearance,
  RuntimeGoalCreateInput,
  RuntimeSendRequest,
} from '@wegent/chat-core/runtime-task-api-types'
export type {
  RuntimeAdditionalContextKind,
  RuntimeAdditionalContextEntry,
  RuntimeAdditionalContext,
  RuntimeTaskSummary,
  RuntimeProjectRef,
  RuntimeProjectSpaceRef,
  RuntimeProjectAiSettings,
  RuntimeProjectQuickPhrase,
  RuntimeProjectPluginRef,
  RuntimeProjectRoot,
  RuntimeProjectAppearance,
  RuntimeDeviceWorkspace,
  RuntimeProjectWork,
  RuntimeWorkListResponse,
  RuntimeGoalExecutionStatus,
  RuntimeGoalCreateInput,
  RuntimeSendRequest,
  RuntimeSendResponse,
  RuntimeGuidanceRequest,
  RuntimeGuidanceResponse,
  RuntimeTaskOrigin,
} from '@wegent/chat-core/runtime-task-api-types'
import type {
  RuntimeGoal,
  RuntimeSupervisorState,
  RuntimeGoalStatus,
  RuntimeSupervisorMode,
  ModelSelectionConfig,
} from '@wegent/chat-core/runtime-stream-types'
export type {
  RuntimeGoal,
  RuntimeGoalContinuationPayload,
  RuntimeSupervisorState,
  RuntimeTaskTitleUpdatedPayload,
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatStartPayload,
  ChatBlockCreatedPayload,
  ChatBlockUpdatedPayload,
  RuntimeGoalEventPayload,
  RuntimePlanEventPayload,
  RuntimeGuidanceAppliedPayload,
  RuntimeSubagentActivityPayload,
  RuntimeSupervisorEventPayload,
  RuntimeGoalStatus,
  RuntimeGoalContinuationStatus,
  RuntimeSupervisorMode,
  RuntimeSupervisorStatus,
  ModelSelectionConfig,
  RuntimeSupervisorSuggestion,
  ChatResultPayload,
  RuntimePlanStep,
  RuntimeSupervisorSuggestionStatus,
  RuntimePlanStepStatus,
} from '@wegent/chat-core/runtime-stream-types'

export type {
  RequestUserInputResponse,
  RequestUserInputResponseAnswer,
} from '@wegent/chat-core/runtime'
import type {
  RuntimeName,
  RuntimeTaskAddress,
  RuntimeMessageSource,
  RuntimeTranscriptResponse,
  TurnFileChangesSummary,
  ChatBlock,
  Attachment,
} from '@wegent/chat-core/runtime'
export type {
  RuntimeName,
  RuntimeTaskAddress,
  RuntimeMessageSource,
  RuntimeMessagePresentationReference,
  NormalizedRuntimeMessage,
  RuntimeTurnNavigationItem,
  CodexReference,
  CodexMemoryCitationEntry,
  CodexMemoryCitation,
  RuntimeTranscriptResponse,
  RuntimeTranscriptTurn,
  RuntimeTranscriptTurnItem,
  RuntimeTranscriptRequest,
  RuntimeTokenUsageBreakdown,
  RuntimeContextUsage,
  TurnFileChangesStatus,
  TurnFileChangeItem,
  TurnFileChangesSummary,
  ChatBlockType,
  ChatBlock,
  AttachmentStatus,
  RuntimeWorkspaceFileReference,
  Attachment,
} from '@wegent/chat-core/runtime'

import type { DeviceSessionTransport, DeviceSessionType } from './device-sessions'

export interface User {
  id: number
  user_name: string
  email: string
  preferences?: UserPreferences | null
}

export interface UserPreferences {
  send_key?: 'enter' | 'cmd_enter'
  follow_up_behavior?: 'queue' | 'guide'
  search_key?: 'cmd_k' | 'cmd_f' | 'disabled'
  memory_enabled?: boolean
  mcp_provider_keys?: Record<string, unknown> | null
  quick_access?: {
    version?: number | null
    teams?: number[]
  } | null
  default_execution_target?: string | null
  wework_new_chat_model_selection?: ModelSelectionConfig | null
  wework_project_execution_mode?: ProjectExecutionMode | null
  wework_project_work_preferences?: Record<string, ProjectWorkPreference> | null
  runtime_configs?: Record<
    string,
    {
      use_user_config?: boolean
    }
  > | null
}

export interface ProjectWorkPreference {
  executionMode?: ProjectExecutionMode | null
  worktreeBranch?: string | null
}

export interface Team {
  id: number
  name: string
  namespace?: string | null
  displayName?: string | null
  is_active: boolean
  default_for_modes?: string[]
  recommended_mode?: 'chat' | 'code' | 'both'
  agent_type?: string | null
}

export interface GitRepoInfo {
  git_repo_id: number
  name: string
  git_repo: string
  git_url: string
  namespace: string
  private: boolean
  git_domain: string
  type: 'github' | 'gitlab' | 'gitee' | 'gitea' | 'gerrit' | string
}

export interface GitBranch {
  name: string
  protected?: boolean
  default?: boolean
}

import type { ModelType, ModelOptions, UnifiedModel } from '@wegent/chat-core/models'
export type {
  ModelType,
  ModelOptions,
  ModelCompatibilityDisabledReason,
  ModelRuntime,
  ModelCapabilities,
  UnifiedModel,
} from '@wegent/chat-core/models'

export interface CreatedRuntimeProject extends ProjectWithTasks {
  runtimeProjectKey: string
}

export type ProjectExecutionMode = string

export interface ProjectListResponse {
  total?: number
  items: ProjectWithTasks[]
}

export interface CreateProjectRequest {
  name: string
  description?: string
  color?: string
  client_origin?: string
  config?: ProjectConfig
}

export interface CreateGitWorkspaceProjectRequest {
  device_id: string
  name?: string
  description?: string
  color?: string
  client_origin?: string
  git: ProjectGitConfig
}

export interface CreateGitWorkspaceProjectResponse {
  project: ProjectWithTasks
  checkout_path: string
  reused_existing_checkout: boolean
}

export interface ProjectWorktreeProjectRef {
  id: number
  name: string
  source_path: string
}

export interface ProjectWorktreeTaskRef {
  id: number
  title: string
  status: string
  project_id: number
}

export interface ProjectWorktreeItem {
  worktree_id: string
  project_name: string
  path: string
  project?: ProjectWorktreeProjectRef | null
  task?: ProjectWorktreeTaskRef | null
}

export interface ProjectWorktreeDeviceGroup {
  device_id: string
  device_name: string
  device_status: 'online' | 'offline' | 'busy' | string
  available: boolean
  error?: string | null
  items: ProjectWorktreeItem[]
}

export interface ProjectWorktreeListResponse {
  devices: ProjectWorktreeDeviceGroup[]
  total: number
}

export interface DeleteProjectWorktreeRequest {
  device_id: string
  worktree_id: string
  project_id: number
}

export interface DeleteProjectWorktreeResponse {
  worktree_id: string
  path: string
  deleted_task_ids: number[]
}

export interface RuntimeSettings {
  maxConcurrentTasks: number
}

export interface RuntimeTaskQueueReorderRequest extends RuntimeTaskAddress {
  queuePosition: number
}

export interface RuntimeTaskQueueReorderResponse extends RuntimeTaskCancelResponse {
  orderedTaskIds?: string[]
}

export interface DeviceWorkspaceUpsert {
  projectId: number
  deviceId: string
  workspacePath: string
  repoUrl?: string | null
  repoRootFingerprint?: string | null
  label?: string | null
}

export interface DeviceWorkspacePrepareRequest {
  projectId: number
  deviceId: string
  workspacePath: string
  action: 'create' | 'select'
  label?: string | null
}

export interface DeleteDeviceWorkspaceRequest {
  projectId: number
  deviceId: string
  workspacePath: string
}

export interface DeleteDeviceWorkspaceResponse {
  deleted: boolean
}

export interface DeviceWorkspaceResponse {
  id: number
  userId: number
  projectId: number
  deviceId: string
  workspacePath: string
  repoUrl?: string | null
  repoRootFingerprint?: string | null
  label?: string | null
  lastSeenAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface DeviceWorkspacePrepareResponse {
  mapping: DeviceWorkspaceResponse
  preparedAction: 'created' | 'selected' | 'cloned' | 'reused_git'
}

export interface RuntimeWorkSearchRequest {
  query: string
  limit?: number
  includeArchived?: boolean
  projectId?: number
  source?: 'all' | 'local' | 'cloud'
}

export interface RuntimeWorkSearchProjectRef {
  id: number
  name: string
}

export interface RuntimeWorkSearchItem {
  address: RuntimeTaskAddress
  runtime: RuntimeName
  title: string
  snippet: string
  matchStart: number
  matchEnd: number
  messageId?: string
  messageRole?: string
  messageCreatedAt?: string | null
  updatedAt?: string | null
  deviceName: string
  workspacePath: string
  project?: RuntimeWorkSearchProjectRef | null
}

export interface RuntimeWorkSearchResponse {
  items: RuntimeWorkSearchItem[]
}

export interface RuntimeWorkspaceSearchRequest {
  deviceId: string
  root: string
  query: string
  cancellationToken?: string
}

export type {
  RuntimeWorkspaceSearchItem,
  RuntimeWorkspaceSearchResponse,
} from '@wegent/chat-core/runtime-workspace-search'

export type RuntimeInterruptAndSendRequest = RuntimeSendRequest

export interface RuntimeRollbackRequest extends RuntimeSendRequest {
  messageId?: string | null
}

export interface RuntimeCompactRequest {
  address: RuntimeTaskAddress
}

export type {
  RuntimeGoalGetRequest,
  RuntimeGoalGetResponse,
} from '@wegent/chat-core/runtime-task-api-types'

export interface RuntimeGoalSetRequest {
  address: RuntimeTaskAddress
  objective?: string | null
  status?: RuntimeGoalStatus | null
  tokenBudget?: number | null
}

export interface RuntimeGoalSetResponse {
  accepted: boolean
  taskId: string
  goal: RuntimeGoal
  resumed?: boolean
  error?: string | null
}

export interface RuntimeGoalClearRequest {
  address: RuntimeTaskAddress
}

export interface RuntimeGoalClearResponse {
  accepted: boolean
  taskId: string
  cleared: boolean
  error?: string | null
}

export interface RuntimeSupervisorGetRequest {
  address: RuntimeTaskAddress
}

export interface RuntimeSupervisorSetRequest {
  address: RuntimeTaskAddress
  mode: RuntimeSupervisorMode
  instructions?: string
  modelSelection?: ModelSelectionConfig | null
  modelConfig?: Record<string, unknown> | null
  intervalSeconds: number
}

export type RuntimeSupervisorCreateInput = Omit<RuntimeSupervisorSetRequest, 'address'>

export interface RuntimeSupervisorClearRequest {
  address: RuntimeTaskAddress
}

export interface RuntimeSupervisorRunNowRequest {
  address: RuntimeTaskAddress
}

export interface RuntimeSupervisorResolveRequest {
  address: RuntimeTaskAddress
  suggestionId: string
  status: 'accepted' | 'dismissed'
}

export interface RuntimeSupervisorResponse {
  accepted: boolean
  taskId: string
  supervisor: RuntimeSupervisorState | null
  error?: string | null
}

export interface RuntimeWorkspaceOpenRequest {
  deviceId: string
  workspacePath: string
  runtime: RuntimeName
  label?: string | null
}

export interface RuntimeLocalProjectUpsertRequest {
  deviceId: string
  projectKey: string
  name: string
  roots: string[]
  defaultProjectSpace?: RuntimeProjectSpaceRef | null
  aiSettings?: RuntimeProjectAiSettings | null
  runtime: 'codex'
}

export interface RuntimeLocalProjectUpsertResponse {
  accepted: boolean
  deviceId: string
  projectKey: string
  name: string
  roots: string[]
  defaultProjectSpace?: RuntimeProjectSpaceRef | null
  aiSettings?: RuntimeProjectAiSettings | null
  runtime: 'codex'
  error?: string | null
}

export interface RuntimeWorkspaceRenameRequest {
  deviceId: string
  projectKey?: string | null
  workspacePath: string
  runtime: RuntimeName
  name: string
}

export interface RuntimeWorkspaceRemoveRequest {
  deviceId: string
  projectKey?: string | null
  workspacePath: string
  runtime: RuntimeName
}

export interface RuntimeWorkspaceOpenResponse {
  accepted: boolean
  deviceId: string
  workspacePath: string
  runtime: RuntimeName
  threadId?: string | null
  error?: string | null
}

export interface RuntimeSidebarMutationResponse {
  accepted: boolean
  deviceId: string
  error?: string | null
}

export interface RuntimeProjectReorderRequest {
  deviceId: string
  projectKey: string
  beforeProjectKey?: string | null
  insertAtEnd?: boolean
}

export interface RuntimeProjectPinRequest {
  deviceId: string
  projectKey: string
  pinned: boolean
  beforeProjectKey?: string | null
}

export interface RuntimeProjectAppearanceRequest {
  deviceId: string
  projectKey: string
  appearance?: RuntimeProjectAppearance | null
}

export interface RuntimeRemoteProjectRegistration {
  id: string
  hostId: string
  remotePath: string
  label?: string | null
}

export interface RuntimeRemoteProjectsSyncRequest {
  deviceId: string
  projects: RuntimeRemoteProjectRegistration[]
}

export interface RuntimeProjectActivateRequest {
  deviceId: string
  projectKey: string
  workspacePath: string
  remoteHostId?: string | null
}

export interface RuntimeProjectTaskReorderRequest {
  deviceId: string
  projectKey: string
  threadId: string
  beforeThreadId?: string | null
  insertAtEnd?: boolean
}

export interface RuntimeTaskPinRequest {
  deviceId: string
  threadId: string
  pinned: boolean
  beforeThreadId?: string | null
}

export interface BindRuntimeTaskIMSessionsRequest {
  address: RuntimeTaskAddress
  taskTitle: string
  sessionKeys: string[]
  modelSelection?: ModelSelectionConfig | null
}

export interface BindRuntimeTaskIMSessionsResponse {
  address: RuntimeTaskAddress
  boundSessionKeys: string[]
  notifiedCount: number
}

export interface RuntimeIMNotificationSession {
  sessionKey: string
  channelType: string
  channelLabel: string
  channelId: number
  conversationId: string
  senderId: string
  displayName?: string | null
}

export interface RuntimeIMNotificationGlobalSettings {
  enabled: boolean
  sessionKey?: string | null
  session?: RuntimeIMNotificationSession | null
}

export interface RuntimeTaskIMNotificationSubscription {
  address: RuntimeTaskAddress
  sessionKeys: string[]
  sessions?: RuntimeIMNotificationSession[]
}

export interface RuntimeIMNotificationSettingsResponse {
  global: RuntimeIMNotificationGlobalSettings
  runtimeTaskSubscriptions: RuntimeTaskIMNotificationSubscription[]
}

export interface RuntimeGlobalIMNotificationUpdateRequest {
  enabled: boolean
  sessionKey?: string | null
}

export interface RuntimeIMNotificationPresenceUpdateRequest {
  clientId: string
  away: boolean
}

export interface RuntimeIMNotificationPresenceResponse {
  away: boolean
  ttlSeconds: number
}

export interface RuntimeTaskIMNotificationSubscriptionRequest {
  address: RuntimeTaskAddress
  sessionKeys: string[]
}

export interface RuntimeTaskIMNotificationSubscriptionResponse {
  address: RuntimeTaskAddress
  subscribed: boolean
  sessionKeys: string[]
}

export interface RuntimeTaskArchiveResponse {
  accepted: boolean
  taskId: string
  workspacePath?: string | null
  error?: string | null
}

export interface RuntimeWorktreeSettings {
  deviceId: string
  worktreeRoot: string
  resolvedWorktreeRoot: string
  autoCleanupEnabled: boolean
  keepCount: number
}

export interface RuntimeWorktreeCapabilitiesRequest {
  deviceId: string
}

export interface RuntimeWorktreeCapabilitiesResponse {
  success: boolean
  deviceId: string
  runtimeWorktrees: RuntimeWorktreeCapability | null
}

export interface RuntimeWorktreePreflightRequest {
  deviceId: string
  sourcePath: string
  ref?: string | null
}

export interface RuntimeWorktreePreflightResponse {
  success: boolean
  deviceId: string
  supported: boolean
  sourcePath: string
  sourceExists: boolean
  sourceDirectory: boolean
  gitRepository: boolean
  gitCommonDirValid: boolean
  gitCommonDirWritable: boolean
  writable: boolean
  repoRoot?: string | null
  gitCommonDir?: string | null
  repoRootFingerprint?: string | null
  gitRef?: string | null
  refValid?: boolean | null
  resolvedWorktreeRoot?: string | null
  errorCode?: string | null
  error?: string | null
}

export interface RuntimeWorktreeSettingsPatch {
  deviceId: string
  worktreeRoot?: string
  autoCleanupEnabled?: boolean
  keepCount?: number
}

export interface RuntimeWorktreeConversation extends RuntimeTaskAddress {
  title: string
  status: string
  running: boolean
  updatedAt?: number | null
}

export type RuntimeManagedWorktreeState =
  | 'active'
  | 'restorable'
  | 'missing'
  | 'deleted'
  | (string & Record<never, never>)

export interface RuntimeManagedWorktreePayload {
  worktreeId: string
  path: string
  repositoryName: string
  sourcePath?: string | null
  permanent: boolean
  createdAt: number
  updatedAt: number
  snapshotRef?: string | null
  snapshotCommit?: string | null
  state: RuntimeManagedWorktreeState
  snapshotAt?: number | null
  gitCommonDir?: string | null
  lastError?: string | null
}

export interface RuntimeManagedWorktree extends RuntimeManagedWorktreePayload {
  deviceId: string
  conversations: RuntimeWorktreeConversation[]
}

export interface RuntimeWorktreeListResponse {
  success: boolean
  deviceId: string
  items: RuntimeManagedWorktree[]
}

export interface RuntimeWorktreePrepareRequest {
  deviceId: string
  sourcePath: string
  worktreeId: string
  ref?: string | null
  permanent?: boolean
}

export interface RuntimeWorktreeMutationResponse {
  success: boolean
  deviceId: string
  worktree: RuntimeManagedWorktreePayload
  path?: string
  archivedTaskCount?: number
}

export interface RuntimeWorktreeDeleteRequest {
  deviceId: string
  path: string
  preserveSnapshot?: boolean
}

export interface ArchivedConversationsListRequest {
  deviceId?: string | null
  workspacePath?: string | null
  projectId?: number | null
  runtimeProjectKey?: string | null
  search?: string | null
  source?: 'all' | 'local' | 'cloud'
  sort?: 'updated' | 'created' | 'alphabetical'
}

export interface ArchivedConversationItem {
  id: string
  taskId: string
  threadId?: string | null
  title: string
  projectId?: number | null
  projectKey?: string | null
  projectName?: string | null
  workspacePath: string
  workspaceKind?: 'workspace' | 'worktree' | 'chat' | string | null
  runtimeHandle?: Record<string, unknown> | null
  deviceId: string
  deviceName?: string | null
  deviceAddress?: string | null
  source: 'local' | 'cloud'
  runtime?: RuntimeName | null
  createdAt?: string | null
  updatedAt?: string | null
}

export interface ArchivedConversationProjectGroup {
  projectId?: number | null
  projectKey?: string | null
  projectName: string
  count: number
}

export interface ArchivedConversationsListResponse {
  items: ArchivedConversationItem[]
  projectGroups: ArchivedConversationProjectGroup[]
  total: number
}

export interface RuntimeArchiveProjectConversationsRequest {
  projectId?: number | null
  runtimeProjectKey?: string | null
}

export interface RuntimeArchivedConversationBulkRequest {
  items: RuntimeTaskAddress[]
}

export interface RuntimeArchivedConversationBulkResponse {
  accepted: boolean
  requestedCount: number
  acceptedCount: number
  deletedCount?: number | null
  cleanup?: RuntimeArchivedConversationCleanupTaskResult | null
  results: Record<string, unknown>[]
  error?: string | null
}

export interface RuntimeArchivedConversationCleanupTarget {
  kind: string
  path: string
  exists: boolean
  bytes: number
  status: 'preview' | 'cleaned' | 'missing' | 'failed' | string
  error?: string | null
}

export interface RuntimeArchivedConversationCleanupTaskResult {
  taskId: string
  workspacePath: string
  targetCount: number
  cleanableCount: number
  skippedCount: number
  errorCount: number
  bytes: number
  items: RuntimeArchivedConversationCleanupTarget[]
}

export interface RuntimeArchivedConversationCleanupResponse {
  success: boolean
  deleted: boolean
  taskCount: number
  targetCount: number
  cleanableCount: number
  skippedCount: number
  errorCount: number
  bytes: number
  results: RuntimeArchivedConversationCleanupTaskResult[]
}

export interface RuntimeTaskRenameRequest {
  address: RuntimeTaskAddress
  title: string
}

export interface RuntimeTaskFriendlyTitleConfig {
  modelId: string
  modelType?: ModelType | null
  modelOptions?: Record<string, string>
}

export interface RuntimeTaskExecutionConfig {
  workspace?: {
    source: string
    branch?: string
  }
}

export interface RuntimeTaskCreateRequest extends RuntimeTaskCreateIntent {
  forceStart?: boolean
  wegentTeamId?: number
  newSession?: boolean
  projectInstructions?: string
  projectPlugins?: RuntimeProjectPluginRef[]
  runtimeExecutablePath?: string
  runtimePermissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
  bot?: Array<Record<string, unknown>>
  title?: string
  modelConfig?: Record<string, unknown>
  friendlyTitle?: RuntimeTaskFriendlyTitleConfig | null
  additionalSkills?: SkillRef[]
  execution?: RuntimeTaskExecutionConfig
  initialGoal?: RuntimeGoalCreateInput | null
  initialSupervisor?: RuntimeSupervisorCreateInput | null
  ephemeral?: boolean
  sideSource?: RuntimeTaskAddress | null
  workspaceSourceTask?: RuntimeTaskAddress | null
  deliveryId?: string
}

export interface RuntimeTaskMaterializeResponse {
  payload: Record<string, unknown>
  runtimeHandle?: Record<string, unknown> | null
}

export interface RuntimeModelPrepareRequest {
  deviceId: string
  modelId?: string
}

export interface RuntimeTaskForkTarget {
  deviceId: string
  workspacePath: string
}

export interface RuntimeTaskForkRequest {
  source: RuntimeTaskAddress
  target: RuntimeTaskForkTarget
  lastTurnId?: string
  title?: string
  modelSelection?: ModelSelectionConfig | null
}

export interface RuntimeTaskForkResponse {
  accepted: boolean
  source: RuntimeTaskAddress
  target: RuntimeTaskAddress
  runtime: RuntimeName
  transcript?: RuntimeTranscriptResponse | null
  setupError?: string | null
  error?: string | null
}

export interface UpdateProjectRequest {
  name?: string
  description?: string
  color?: string
  config?: ProjectConfig
}

export interface Task {
  id: number
  title: string
  status: string
  task_type?: 'chat' | 'code' | 'task' | 'knowledge' | 'video' | 'image'
  team_id?: number
  project_id?: number
  client_origin?: string
  source?: string | null
  device_id?: string | null
  execution_workspace_source?: string | null
  execution_workspace_path?: string | null
  created_at: string
  updated_at?: string
  is_group_chat?: boolean
  model_id?: string | null
  force_override_bot_model_type?: ModelType | null
  model_options?: Record<string, unknown> | null
  requested_skills?: SkillRef[]
}

export interface TaskListResponse {
  total: number
  items: Task[]
}

export interface IMPrivateSession {
  session_key: string
  channel_type: string
  channel_label: string
  channel_id: number
  conversation_id: string
  sender_id: string
  display_name: string
  mode: 'chat' | 'task'
  state: 'idle' | 'pending_new_flow' | 'pending_task_switch' | 'pending_task_creation'
  active_task_id?: string | null
  last_seen_at: string
}

export interface IMPrivateSessionListResponse {
  total: number
  items: IMPrivateSession[]
}

export interface ArchivedTask {
  id: number
  title: string
  status: string
  task_type: string
  type: string
  created_at: string
  updated_at: string
  completed_at?: string | null
  project_id: number
  client_origin?: string
  project_name?: string | null
}

export interface ArchivedTaskListResponse {
  total: number
  items: ArchivedTask[]
}

export interface TaskArchiveBatchResponse {
  message: string
  count: number
}

export interface TaskArchiveResponse {
  message: string
  task_id: string
}

export interface DeviceCommandRequest {
  command_key: string
  path?: string
  cwd?: string
  args?: string[]
  env?: Record<string, unknown>
  timeout_seconds?: number
  max_output_bytes?: number
}

export interface SkillDirectoryMove {
  source: string
  from: string
  to: string
  renamed: boolean
}

export interface SkillDirectoryLink {
  path: string
  target: string
  status: 'created' | 'already_configured' | string
}

export interface SkillDirectorySetupResult {
  success: boolean
  status: 'configured' | 'failed' | string
  shared_path: string
  shared_created: boolean
  legacy_paths: string[]
  moved_count: number
  moved: SkillDirectoryMove[]
  links: SkillDirectoryLink[]
  error?: string
}

export interface DeviceCommandResponse {
  success: boolean
  exit_code?: number | null
  stdout:
    | string
    | string[]
    | LocalDeviceSkill[]
    | SkillDirectorySetupResult
    | Record<string, unknown>
  stderr: string
  error?: string
  duration?: number
  timed_out?: boolean
  stdout_truncated?: boolean
  stderr_truncated?: boolean
}

export interface CloneGitRepositoryInput {
  url: string
  branch?: string
  targetPath: string
}

export interface GitCloneProjectOperation extends CloneGitRepositoryInput {
  id: string
  deviceId: string
  name: string
  status: 'cloning' | 'opening' | 'failed'
  failureStage?: 'clone' | 'open'
  failureReason?: 'executor-offline' | 'clone-failed' | 'open-failed'
  error?: string
}

export interface TaskContextData {
  id: number
  context_type: 'attachment' | 'knowledge_base'
  name: string
  status: string
  file_extension?: string
  file_size?: number
  mime_type?: string
}

export interface Subtask {
  id: number
  task_id?: string
  role: string
  prompt?: string
  result?: unknown
  error_message?: string | null
  status: string
  message_id?: number
  created_at: string
  updated_at?: string
  completed_at?: string | null
  contexts?: TaskContextData[]
  attachments?: Attachment[]
  sender_user_name?: string
}

export interface TurnFileChangesDiffResponse {
  subtask_id: string
  diff: string
}

export interface TurnFileChangesRevertResponse {
  subtask_id: string
  file_changes: TurnFileChangesSummary
}

export type {
  RuntimeFileChangesRevertRequest,
  RuntimeFileChangesRevertResponse,
} from '@wegent/chat-core/runtime-file-changes'

export interface TaskDetail extends Task {
  subtasks?: Subtask[]
}

export type TaskForkTarget =
  | {
      type: 'managed'
    }
  | {
      type: 'device'
      device_id: string
    }

export interface TaskForkRequest {
  target: TaskForkTarget
}

export interface TaskForkResponse {
  task_id: string
  task: TaskDetail
}

export interface CreateProjectConversationRequest {
  prompt: string
  title?: string
  new_session?: boolean
}

export interface CreateProjectConversationResponse {
  task_id: string
  project_id: number
  task: unknown
}

export interface ProjectDeviceSessionResponse {
  session_id: string
  project_id: number
  device_id: string
  type: DeviceSessionType
  path: string
  url: string
  transport?: DeviceSessionTransport
  expires_at?: string | null
}

export interface ChatSendPayload {
  task_id?: string
  team_id: number
  message: string
  title?: string
  task_type?: 'chat' | 'code' | 'task' | 'knowledge' | 'video' | 'image'
  project_id?: number
  client_origin?: string
  device_id?: string
  model_id?: string
  force_override_bot_model?: string
  force_override_bot_model_type?: ModelType
  model_options?: ModelOptions
  attachment_ids?: number[]
  attachments?: Attachment[]
  additional_skills?: SkillRef[]
  execution?: {
    workspace?: {
      source: string
      branch?: string
    }
  }
}

export interface ChatSendAck {
  success?: boolean
  task_id?: string
  error?: string
}

export interface ChatGuidePayload {
  task_id: string
  subtask_id: string
  team_id: number
  message: string
  guidance?: string
  client_guidance_id?: string
}

export interface ChatGuideAck {
  success?: boolean
  guidance_id?: string
  error?: string
}

export interface ChatCancelPayload {
  subtask_id: string
  partial_content?: string
  shell_type?: string
}

export interface ChatCancelAck {
  success?: boolean
  error?: string
}

export interface ChatMessagePayload {
  task_id?: string
  subtask_id: string
  role: string
  content: string
  sender?: Record<string, unknown>
  created_at: string
  attachments?: Attachment[]
  source?: RuntimeMessageSource | null
  device_id?: string
  runtime?: RuntimeName
}

export interface TaskJoinResponse {
  streaming?: {
    subtask_id: string
    offset: number
    cached_content: string
    blocks?: ChatBlock[]
  }
  subtasks?: Array<Record<string, unknown>>
  error?: string
}

export type SystemSkillInstallState =
  | 'not_installed'
  | 'installed'
  | 'update_available'
  | 'unavailable'
  | 'failed'

export interface SystemSkillProviderInfo {
  key: string
  name: string
  description: string
  requiresToken: boolean
  hasToken: boolean
  priority: number
}

export interface SystemSkillProviderListResponse {
  providers: SystemSkillProviderInfo[]
}

export interface SystemSkillCatalogItem {
  id: string
  providerKey: string
  providerName: string
  name: string
  displayName: string
  description: string
  iconUrl?: string | null
  tags: string[]
  version?: string | null
  author?: string | null
  category: 'system'
  capabilities: string[]
  detailUrl?: string | null
  installState: SystemSkillInstallState
  installedSkillId?: number | null
  enabled: boolean
  requiresPermission: boolean
  permissionUrl?: string | null
  updatedAt?: string | null
}

export interface SystemSkillInstallRequest {
  providerKey: string
  skillKey: string
  catalogItemId?: string | null
  displayName: string
  description: string
  version?: string | null
  author?: string | null
  tags: string[]
}

export interface InstalledSkillSource {
  type: 'system' | 'personal' | 'git' | 'market'
  providerKey?: string | null
  skillKey: string
  catalogItemId?: string | null
}

export interface InstalledSkillRef {
  kind: string
  name: string
  namespace: string
  user_id?: number | null
}

export interface InstalledSkill {
  apiVersion: string
  kind: 'InstalledSkill'
  metadata: Record<string, unknown>
  spec: {
    source: InstalledSkillSource
    skillRef?: InstalledSkillRef | null
    displayName: string
    description: string
    version?: string | null
    installState: SystemSkillInstallState
    enabled: boolean
    sourcePayload?: Record<string, unknown> | null
  }
  status: {
    state: string
  }
}

export interface InstalledSkillListResponse {
  items: InstalledSkill[]
}

export interface SystemSkillProviderError {
  providerKey: string
  code:
    | 'token_required'
    | 'unauthorized'
    | 'timeout'
    | 'connect_error'
    | 'provider_error'
    | 'mapping_error'
  message: string
}

export interface SystemSkillListResponse {
  total: number
  page: number
  pageSize: number
  items: SystemSkillCatalogItem[]
  providerErrors: SystemSkillProviderError[]
}

export interface PersonalSkill {
  apiVersion: string
  kind: 'Skill'
  metadata: {
    name: string
    namespace: string
    labels?: Record<string, unknown>
    annotations?: Record<string, unknown>
  }
  spec: {
    description: string
    enabled?: boolean
    displayName?: string | null
    version?: string | null
    author?: string | null
    tags?: string[] | null
    prompt?: string | null
  }
  status?: Record<string, unknown>
}

export interface PersonalSkillListResponse {
  items: PersonalSkill[]
}

export interface MCPProviderInfo {
  key: string
  name: string
  name_en?: string | null
  description: string
  discover_url: string
  api_key_url: string
  token_field_name: string
  requires_token: boolean
  has_token: boolean
}

export interface MCPProviderListResponse {
  providers: MCPProviderInfo[]
}

export interface MCPServer {
  id: string
  name: string
  description?: string | null
  type: 'streamable-http' | 'sse' | 'stdio' | 'http'
  base_url?: string | null
  command?: string | null
  args?: string[] | null
  env?: Record<string, string> | null
  headers?: Record<string, string> | null
  is_active: boolean
  provider: string
  provider_url?: string | null
  logo_url?: string | null
  tags?: string[] | null
  installState: MCPInstallState
  installedMcpId?: number | null
  enabled: boolean
}

export interface MCPServerListResponse {
  success: boolean
  message: string
  servers: MCPServer[]
  error_details?: string | null
}

export interface MCPProviderKeysRequest {
  [key: string]: string | null | undefined
}

export interface MCPProviderKeysResponse {
  success: boolean
  message: string
}

export type MCPInstallState =
  | 'not_installed'
  | 'installed'
  | 'update_available'
  | 'unavailable'
  | 'failed'
  | 'uninstalled'

export interface InstalledMCPServerConfig {
  type: 'streamable-http' | 'sse' | 'stdio' | 'http'
  url?: string | null
  base_url?: string | null
  command?: string | null
  args?: string[] | null
  env?: Record<string, string> | null
  headers?: Record<string, string> | null
}

export interface InstalledMCPSource {
  type: 'custom' | 'provider'
  providerKey?: string | null
  serverKey: string
  catalogItemId?: string | null
}

export interface InstalledMCP {
  apiVersion: string
  kind: 'InstalledMCP'
  metadata: Record<string, unknown>
  spec: {
    source: InstalledMCPSource
    displayName: string
    description: string
    server: InstalledMCPServerConfig
    installState: MCPInstallState
    enabled: boolean
    sourcePayload?: Record<string, unknown> | null
  }
  status: {
    state: string
  }
}

export interface InstalledMCPListResponse {
  items: InstalledMCP[]
}

export interface InstalledMCPUpdateRequest {
  enabled?: boolean
  displayName?: string
  description?: string
  server?: InstalledMCPServerConfig
}

export interface InstalledMCPCustomCreateRequest {
  name: string
  displayName: string
  description?: string
  server: InstalledMCPServerConfig
  enabled?: boolean
}

export interface InstalledMCPInstallRequest {
  providerKey: string
  serverKey: string
  catalogItemId?: string | null
  displayName: string
  description?: string
  server: InstalledMCPServerConfig
  sourcePayload?: Record<string, unknown> | null
}

export interface InstalledPluginListResponse {
  items: InstalledPlugin[]
}

export interface PluginMarketplaceItem {
  id: string | number
  remotePluginId: string
  name: string
  displayName: string
  description: string
  version?: string | null
  author?: string | null
  visibility: 'personal' | 'workspace' | 'public'
  featured: boolean
  installed: boolean
  installedPluginId?: string | number | null
  installedLocally?: boolean
  /** Materialized package version on this device (may lag catalog `version`). */
  installedVersion?: string | null
  enabled: boolean
  sourceType: 'marketplace'
  interface?: PluginInterface | null
  components: InstalledPluginComponents
  manifest: Record<string, unknown>
  ownerUserId: number
  ownerDisplayName?: string
  originPersonalPluginId?: number | null
  accessRole?: 'catalog' | 'owner' | 'recipient'
  allowCopy?: boolean
  grantUserCount?: number
  grantNamespaceCount?: number
  latestReleaseId?: number | null
  listingType?: 'plugin' | 'skill'
  origin?: 'market'
  sourceProvider?: 'wegent' | 'codex' | 'user'
  sourceLabel?: string
  localPersonalSource?: {
    marketplacePath: string
    pluginName: string
  } | null
  updateAvailable?: boolean
  currentDeviceInstallation?: {
    deviceId: string
    desiredReleaseId: number
    actualReleaseId?: number | null
    state: 'pending' | 'downloading' | 'installing' | 'installed' | 'failed' | 'uninstalling'
    errorCode?: string | null
    errorMessage?: string | null
    attemptCount: number
    lastSyncAt?: string | null
    updatedAt: string
  } | null
}

export interface PluginMarketplaceListResponse {
  items: PluginMarketplaceItem[]
}

export interface DeviceCapabilityItemResult {
  id?: string | number | null
  name?: string | null
  status: string
  stage?: string | null
  error_code?: string | null
  retryable?: boolean | null
  error?: string | null
}

export interface DeviceCapabilitySyncResult {
  device_id: string
  success: boolean
  error?: string | null
  skills: DeviceCapabilityItemResult[]
  plugins: DeviceCapabilityItemResult[]
  mcps: DeviceCapabilityItemResult[]
  errors: Array<Record<string, unknown>>
}

export interface DeviceCapabilitySyncResponse {
  success: boolean
  device_id: string
  mode: string
  skills: DeviceCapabilityItemResult[]
  plugins: DeviceCapabilityItemResult[]
  mcps: DeviceCapabilityItemResult[]
  errors: Array<Record<string, unknown>>
  synced: number
  failed: number
  skipped: number
  results: DeviceCapabilitySyncResult[]
}

export interface PluginMarketplaceInstallResponse {
  plugin: InstalledPlugin
  sync?: DeviceCapabilitySyncResponse | null
}

export interface PluginDeviceSyncResponse {
  reconciled?: boolean
  deviceId: string
  pendingCount: number
  sync: DeviceCapabilitySyncResponse
}

export interface PluginDeviceReportItem {
  installedPluginId: number
  releaseId: number
  version: string
}

export interface PluginDeviceReportResponse {
  deviceId: string
  acknowledgedCount: number
  acknowledgedInstalledPluginIds: number[]
}

export interface PluginAutoUpdateItem {
  installedPluginId: number
  pluginId: number
  fromReleaseId: number
  toReleaseId: number
  version: string
}

export interface PluginAutoUpdateBatchResponse {
  updated: PluginAutoUpdateItem[]
  updatedCount: number
  remainingCount: number
}

export interface InstalledPluginUpdateRequest {
  enabled?: boolean
  componentStates?: Record<string, boolean>
  displayName?: string
  description?: string
  releaseId?: number
  updatePolicy?: 'manual' | 'auto'
}

export interface PluginSubmissionInitRequest {
  slug: string
  displayName: string
  version: string
  filename: string
  sha256: string
  sizeBytes: number
  listingType?: 'plugin' | 'skill'
  purpose?: 'marketplace_publish' | 'restricted_share'
  visibility?: 'personal' | 'workspace' | 'public'
  targets?: PluginAccessTarget[]
  allowCopy?: boolean
}

export interface PluginSubmissionInitResponse {
  submissionId: number
  pluginId: number
  releaseId: number
  purpose?: 'marketplace_publish' | 'restricted_share'
  uploadUrl: string
  expiresAt: string
}

export interface PluginSubmissionItem {
  id: number
  pluginId: number
  releaseId: number
  status: 'uploading' | 'scanning' | 'pending' | 'approved' | 'rejected' | 'cancelled'
  reviewNote: string
  submittedAt: string
  reviewedAt?: string | null
}

export interface PluginSubmissionCompleteResponse {
  submission: PluginSubmissionItem
  plugin?: PluginMarketplaceItem | null
}

export type PluginPublicationStage =
  | 'submit_request'
  | 'automated_checks'
  | 'administrator_review'
  | 'code_review'
  | 'release'

export type PluginPublicationStatus =
  | 'uploading'
  | 'submitted'
  | 'automatic_checking'
  | 'automatic_check_failed'
  | 'awaiting_admin'
  | 'admin_review'
  | 'changes_requested'
  | 'admin_accepted'
  | 'materializing'
  | 'draft_mr_open'
  | 'ci_running'
  | 'code_changes_requested'
  | 'merge_ready'
  | 'merged'
  | 'publishing'
  | 'published'
  | 'publish_failed'
  | 'withdrawn'
  | 'closed'

export interface PluginPublicationCheckItem {
  id: number
  checkCode: string
  title: string
  severity: 'info' | 'warning' | 'blocker'
  status: 'pending' | 'running' | 'passed' | 'warning' | 'blocked' | 'failed' | 'not_run'
  summary?: string | null
  evidence: string[]
  jobUrl?: string | null
  acknowledgementRequired: boolean
  acknowledged: boolean
}

export interface PluginPublicationEventItem {
  id: number
  eventType: string
  actorType: 'user' | 'admin' | 'gitlab' | 'pipeline' | 'release_service' | 'system'
  actorName?: string | null
  message: string
  requiredChanges?: string[]
  failureDetails?: PluginPublicationFailureDetail[]
  createdAt: string
}

export interface PluginPublicationFailureDetail {
  jobName: string
  stage?: string | null
  status: string
  reason?: string | null
  jobUrl?: string | null
}

export interface PluginPublicationGitLabState {
  projectUrl?: string | null
  sourceBranch?: string | null
  mergeRequestIid?: number | null
  mergeRequestUrl?: string | null
  mergeRequestStatus?: string | null
  pipelineId?: number | null
  pipelineUrl?: string | null
  pipelineStatus?: string | null
  commitSha?: string | null
}

export interface PluginPublicationRevisionItem {
  id: number
  number: number
  requestedVersion: string
  snapshotSha256: string
  sourceTreeSha256?: string | null
  status: PluginPublicationStatus
  releaseNotes?: string | null
  testNotes?: string | null
  sourceUpdatedAt?: string | null
  createdAt: string
  declarations: Array<{
    key: string
    label: string
    declared: boolean
    detected?: boolean | null
    confirmed?: boolean | null
    details: string[]
  }>
  manifest: Record<string, unknown>
  packageEntries: string[]
  packageEntryCount: number
  packageEntriesTruncated: boolean
  capabilities: string[]
}

export interface PluginPublicationActionEligibility {
  canWithdraw: boolean
  canCreateRevision: boolean
  canViewEnterprisePlugin: boolean
  canReturn: boolean
  canAccept: boolean
  canReconcile: boolean
  blockedReasons: string[]
}

export interface PluginPublicationRequestSummary {
  id: number
  pluginId: number
  pluginName: string
  pluginSlug: string
  requestedVersion: string
  submitter: { id: number; userName: string; email?: string | null }
  currentRevision: number
  stage: PluginPublicationStage
  status: PluginPublicationStatus
  riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical'
  blockerCount: number
  warningCount: number
  gitlabStatus?: string | null
  waitingDurationSeconds: number
  submittedAt: string
  updatedAt: string
}

export interface PluginPublicationRequestItem extends PluginPublicationRequestSummary {
  enterprisePluginId?: number | null
  revision: PluginPublicationRevisionItem
  revisions: PluginPublicationRevisionItem[]
  checks: PluginPublicationCheckItem[]
  events: PluginPublicationEventItem[]
  gitlab: PluginPublicationGitLabState | null
  actionEligibility: PluginPublicationActionEligibility
}

export interface PluginPublicationRequestListResponse {
  items: PluginPublicationRequestSummary[]
  total: number
  page: number
  limit: number
}

export interface PluginPublicationCreateRequest {
  sourcePluginId?: number
  slug: string
  displayName: string
  requestedVersion: string
  filename: string
  snapshotSha256: string
  sizeBytes: number
  listingType?: 'plugin' | 'skill'
  releaseNotes: string
  testNotes: string
  sourceUpdatedAt?: string | null
  riskDeclaration: Record<string, unknown>
}

export interface PluginPublicationInitResponse {
  requestId: number
  sourcePluginId: number
  revision: PluginPublicationRevisionItem
  uploadUrl: string
  expiresAt: string
}

export interface PluginAccessTarget {
  entityType: 'user' | 'namespace'
  entityId: string
  displayName: string
}

export interface PluginAccessUpdateRequest {
  scope: 'private' | 'restricted'
  targets: PluginAccessTarget[]
  allowCopy: boolean
}

export interface PluginAccessResponse extends PluginAccessUpdateRequest {
  pluginId: number
  revocationPendingCount: number
}

export interface PluginDeleteImpactResponse {
  pluginId: number
  affectedUserCount: number
  installedDeviceCount: number
  sharedTargetCount: number
  impactRevision: string
}

export interface PluginDeleteRequest {
  impactRevision: string
  revokeAndDelete: boolean
}

export interface PluginDeleteResponse {
  pendingDeviceCount: number
}

export interface PluginCopyResponse {
  sourcePluginId: number
  sourceReleaseId: number
  sourcePluginName: string
  sourceDisplayName: string
  version: string
  sha256: string
  downloadUrl: string
  expiresAt: string
}

export interface ChatGuidanceQueuedPayload {
  task_id: string
  subtask_id: string
  team_id?: number
  user_id?: number
  guidance_id: string
  client_guidance_id?: string
  message?: string
  content?: string
  created_at?: string
}

export interface ChatGuidanceAppliedPayload {
  task_id: string
  subtask_id: string
  guidance_id: string
  client_guidance_id?: string
  applied_at: string
}

export interface ChatGuidanceExpiredPayload {
  task_id: string
  subtask_id: string
  guidance_ids: string[]
}

export interface UnifiedModelListResponse {
  data: UnifiedModel[]
}

export interface UnifiedSkill {
  id: number
  name: string
  namespace: string
  description: string
  displayName?: string
  version?: string
  author?: string
  tags?: string[]
  bindShells?: string[]
  visible?: boolean
  is_active: boolean
  is_public: boolean
  user_id: number
  created_at?: string
  updated_at?: string
}

export interface SkillRef {
  name: string
  namespace: string
  is_public: boolean
}

export interface AttachmentUploadProgress {
  file: File
  progress: number
  previewUrl?: string
}

export interface MultiAttachmentUploadState {
  attachments: Attachment[]
  uploadingFiles: Map<string, AttachmentUploadProgress>
  errors: Map<string, string>
}
