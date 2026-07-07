import type { DeviceSessionTransport, DeviceSessionType } from './device-sessions'

export interface User {
  id: number
  user_name: string
  email: string
  preferences?: UserPreferences | null
}

export interface UserPreferences {
  send_key?: 'enter' | 'cmd_enter'
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
      use_proxy?: boolean
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
  displayName?: string | null
  is_active: boolean
  default_for_modes?: string[]
  recommended_mode?: 'chat' | 'code' | 'both'
  agent_type?: string | null
}

export interface ProjectExecutionConfig {
  targetType: 'local' | 'cloud'
  deviceId?: string
}

export interface ProjectWorkspaceConfig {
  source: 'git' | 'local_path'
  localPath?: string
  checkoutPath?: string
}

export interface ProjectGitConfig {
  url: string
  repo?: string | null
  repoId?: number | null
  domain?: string | null
  branch?: string | null
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

export type ModelType = 'public' | 'user' | 'group' | 'runtime'

export interface ModelSelectionConfig {
  modelName: string
  modelType?: ModelType | null
  options?: Record<string, string>
}

export interface ProjectConfig {
  mode?: 'workspace' | string
  path?: string
  device_id?: string
  execution?: ProjectExecutionConfig | null
  workspace?: ProjectWorkspaceConfig | null
  git?: ProjectGitConfig | null
  modelSelection?: ModelSelectionConfig | null
}

export interface DeviceInfo {
  id: number
  device_id: string
  name: string
  status: 'online' | 'offline' | 'busy'
  is_default: boolean
  device_type?: 'local' | 'app' | 'cloud' | 'remote' | string
  capabilities?: string[] | null
  slot_used?: number
  slot_max?: number
  running_tasks?: DeviceRunningTask[]
  running_task_ids?: number[]
  executor_version?: string | null
  latest_version?: string | null
  update_available?: boolean
  error?: string | null
  bind_shell?: 'claudecode' | 'openclaw' | string
  client_ip?: string | null
  runtime_transfer_host?: string | null
  app_device_id?: string | null
}

export interface DeviceRunningTask {
  task_id?: number
  subtask_id?: number
  title?: string
  status?: string
  created_at?: string
}

export interface ProjectTask {
  id: number
  task_id: number
  task_title?: string
  task_status?: string
  title?: string
  status?: string
  source?: string | null
  device_id?: string | null
  execution_workspace_source?: string | null
  execution_workspace_path?: string | null
  created_at?: string
  updated_at?: string
  task_type?: string
}

export interface ProjectWithTasks {
  id: number
  name: string
  description?: string | null
  color?: string | null
  client_origin?: string
  config?: ProjectConfig | null
  tasks?: ProjectTask[]
}

export type ProjectExecutionMode = 'current_workspace' | 'git_worktree'

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

export type RuntimeName = 'codex' | 'claude_code' | 'claude' | string

export interface RuntimeTaskAddress {
  deviceId: string
  taskId: string
  workspacePath?: string | null
  runtimeHandle?: Record<string, unknown> | null
}

export interface RuntimeMessageSource {
  source: 'im' | 'manual' | string
  external_id?: string | null
  channel_type?: string | null
  channel_label?: string | null
  channel_id?: number | null
  conversation_id?: string | null
  sender_id?: string | null
  message_id?: string | null
}

export interface NormalizedRuntimeMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | string
  content: string
  messageIndex?: number | null
  message_index?: number | null
  subtaskId?: string | null
  status?: string | null
  createdAt?: string | null
  completedAt?: string | number | null
  completed_at?: string | number | null
  stoppedNotice?: boolean | null
  stopped_notice?: boolean | null
  runtimeGoalRequest?: boolean | null
  runtime_goal_request?: boolean | null
  source?: RuntimeMessageSource | null
  attachments?: Attachment[]
  blocks?: ChatBlock[]
  fileChanges?: TurnFileChangesSummary | null
  file_changes?: TurnFileChangesSummary | null
  references?: CodexReference[] | null
  memoryCitations?: CodexMemoryCitation[] | null
  memory_citations?: CodexMemoryCitation[] | null
  memoryCitation?: CodexMemoryCitation | null
  memory_citation?: CodexMemoryCitation | null
}

export interface RuntimeTurnNavigationItem {
  id: string
  turnIndex: number
  messageIndex: number
  cursor?: string | null
  promptPreview: string
  responsePreview?: string | null
}

export interface CodexReference {
  path: string
  title?: string | null
  lineStart?: number | null
  lineEnd?: number | null
}

export interface CodexMemoryCitationEntry {
  path: string
  lineStart?: number | null
  line_start?: number | null
  lineEnd?: number | null
  line_end?: number | null
  note?: string | null
}

export interface CodexMemoryCitation {
  entries?: CodexMemoryCitationEntry[]
  rolloutIds?: string[]
  rollout_ids?: string[]
  threadIds?: string[]
  thread_ids?: string[]
}

export interface RuntimeTaskSummary {
  taskId: string
  workspacePath: string
  workspaceKind?: 'workspace' | 'worktree' | 'chat' | string | null
  worktreeId?: string | null
  gitInfo?: Record<string, unknown> | null
  title: string
  runtime: RuntimeName
  createdAt?: string | number | null
  updatedAt?: string | number | null
  running?: boolean
  status?: string | null
  runtimeHandle?: Record<string, unknown> | null
  modelSelection?: ModelSelectionConfig | null
  parent?: Record<string, unknown> | null
  children?: Record<string, unknown>[]
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

export interface RuntimeProjectRef {
  key: string
  id?: number
  name: string
  description?: string | null
  color?: string | null
}

export interface RuntimeDeviceWorkspace {
  id?: number | null
  projectId?: number | null
  deviceId: string
  deviceName?: string | null
  deviceStatus?: DeviceInfo['status'] | string | null
  available: boolean
  workspacePath: string
  workspaceKind?: 'workspace' | 'worktree' | 'chat' | string | null
  worktreeId?: string | null
  label?: string | null
  workspaceSource?: 'local' | 'remote' | string | null
  remoteHostId?: string | null
  repoUrl?: string | null
  repoRootFingerprint?: string | null
  mapped?: boolean
  tasks: RuntimeTaskSummary[]
  error?: string | null
}

export interface RuntimeProjectWork {
  project: RuntimeProjectRef
  deviceWorkspaces: RuntimeDeviceWorkspace[]
  totalTasks?: number
}

export interface RuntimeWorkListResponse {
  projects: RuntimeProjectWork[]
  chats: RuntimeDeviceWorkspace[]
  totalTasks: number
}

export interface RuntimeWorkSearchRequest {
  query: string
  limit?: number
  includeArchived?: boolean
  projectId?: number
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

export interface RuntimeTranscriptResponse {
  taskId?: string
  workspacePath: string
  runtime: RuntimeName
  title?: string | null
  messages: NormalizedRuntimeMessage[]
  contextUsage?: RuntimeContextUsage | null
  turnNavigation?: RuntimeTurnNavigationItem[]
  rangeStart?: number | null
  rangeEnd?: number | null
  hasMoreBefore?: boolean
  beforeCursor?: string | null
  hasMoreAfter?: boolean
  afterCursor?: string | null
  parseError?: string | null
}

export interface RuntimeTranscriptRequest extends RuntimeTaskAddress {
  limit?: number
  beforeCursor?: string | null
  afterCursor?: string | null
  refresh?: boolean
}

export interface RuntimeSendRequest {
  address: RuntimeTaskAddress
  message: string
  ephemeral?: boolean
  modelId?: string
  modelType?: ModelType | null
  modelOptions?: ModelOptions
  collaborationMode?: string
  attachmentIds?: number[]
  attachments?: Attachment[]
  source?: RuntimeMessageSource | null
  requestUserInputResponse?: RequestUserInputResponse
  request_user_input_response?: RequestUserInputResponse
}

export interface RuntimeRollbackRequest extends RuntimeSendRequest {
  messageId?: string | null
}

export interface RequestUserInputResponseAnswer {
  answers: string[]
}

export interface RequestUserInputResponse {
  requestId?: number | string
  request_id?: number | string
  itemId?: string
  item_id?: string
  answers: Record<string, RequestUserInputResponseAnswer>
}

export interface RuntimeSendResponse {
  accepted: boolean
  taskId: string
  error?: string | null
}

export interface RuntimeGuidanceRequest {
  address: RuntimeTaskAddress
  message: string
  clientGuidanceId?: string
  client_guidance_id?: string
}

export interface RuntimeGuidanceResponse {
  accepted?: boolean
  success?: boolean
  taskId?: string
  task_id?: string
  guidanceId?: string
  guidance_id?: string
  turnId?: string
  turn_id?: string
  error?: string | null
  code?: string | null
}

export type RuntimeGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete'

export interface RuntimeGoal {
  threadId: string
  objective: string
  status: RuntimeGoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

export interface RuntimeGoalCreateInput {
  objective: string
  status?: RuntimeGoalStatus | null
  tokenBudget?: number | null
}

export interface RuntimeGoalGetRequest {
  address: RuntimeTaskAddress
}

export interface RuntimeGoalGetResponse {
  accepted: boolean
  taskId: string
  goal: RuntimeGoal | null
  error?: string | null
}

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

export interface RuntimeWorkspaceOpenRequest {
  deviceId: string
  workspacePath: string
  runtime: RuntimeName
  label?: string | null
}

export interface RuntimeWorkspaceRenameRequest {
  deviceId: string
  workspacePath: string
  runtime: RuntimeName
  name: string
}

export interface RuntimeWorkspaceRemoveRequest {
  deviceId: string
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

export interface BindRuntimeTaskIMSessionsRequest {
  address: RuntimeTaskAddress
  sessionKeys: string[]
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
  title: string
  projectId?: number | null
  projectKey?: string | null
  projectName?: string | null
  workspacePath: string
  workspaceKind?: 'workspace' | 'worktree' | 'chat' | string | null
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
  results: Record<string, unknown>[]
  error?: string | null
}

export interface RuntimeTaskRenameRequest {
  address: RuntimeTaskAddress
  title: string
}

export interface RuntimeTaskCancelResponse {
  accepted: boolean
  taskId?: string
  workspacePath?: string | null
  error?: string | null
}

export interface RuntimeTaskCreateRequest {
  projectId?: number
  deviceWorkspaceId?: number
  deviceId?: string
  workspacePath?: string
  taskId?: string
  teamId: number
  runtime: RuntimeName
  message: string
  title?: string
  modelId?: string
  modelType?: ModelType | null
  modelOptions?: Record<string, string>
  additionalSkills?: SkillRef[]
  attachmentIds?: number[]
  attachments?: Attachment[]
  execution?: ChatSendPayload['execution']
  initialGoal?: RuntimeGoalCreateInput | null
  ephemeral?: boolean
  sideSource?: RuntimeTaskAddress | null
}

export interface RuntimeTaskCreateResponse {
  accepted: boolean
  deviceId: string
  taskId: string
  workspacePath: string
  runtime: RuntimeName
  error?: string | null
}

export interface RuntimeTaskForkTarget {
  deviceId: string
  workspacePath: string
}

export interface RuntimeTaskForkRequest {
  source: RuntimeTaskAddress
  target: RuntimeTaskForkTarget
}

export interface RuntimeTaskForkResponse {
  accepted: boolean
  source: RuntimeTaskAddress
  target: RuntimeTaskAddress
  runtime: RuntimeName
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

export interface LocalDeviceSkill {
  name: string
  description: string
  short_description?: string | null
  path: string
  source: 'claude' | 'codex' | string
  scope?: 'user' | 'system' | 'repo' | 'admin' | string
  source_label?: string | null
  source_priority?: number
  origin?: 'local' | 'wegent' | string
  plugin_name?: string | null
  plugin_provider?: string | null
  plugin_version?: string | null
  mtime?: number
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

export type TurnFileChangesStatus = 'active' | 'reverted' | 'conflicted' | 'artifact_missing'

export interface TurnFileChangeItem {
  old_path?: string | null
  path: string
  change_type: 'created' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  binary: boolean
}

export interface TurnFileChangesSummary {
  version: 1
  status: TurnFileChangesStatus
  artifact_id: string
  device_id: string
  workspace_path: string
  file_count: number
  additions: number
  deletions: number
  files: TurnFileChangeItem[]
  reverted_at?: string | null
  diff?: string
  revertible?: boolean
}

export interface TurnFileChangesDiffResponse {
  subtask_id: string
  diff: string
}

export interface TurnFileChangesRevertResponse {
  subtask_id: string
  file_changes: TurnFileChangesSummary
}

export interface RuntimeFileChangesRevertRequest {
  address: RuntimeTaskAddress
  fileChanges: TurnFileChangesSummary
}

export interface RuntimeFileChangesRevertResponse {
  fileChanges: TurnFileChangesSummary
  file_changes?: TurnFileChangesSummary
}

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
      source: 'git_worktree'
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

export interface ChatStartPayload {
  taskId?: string
  subtaskId?: string
  bot_name?: string
  shellType?: string
  deviceId?: string
}

export interface RuntimeTokenUsageBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface RuntimeContextUsage {
  total: RuntimeTokenUsageBreakdown
  last: RuntimeTokenUsageBreakdown
  modelContextWindow: number
}

export type ChatResultPayload = Record<string, unknown> & {
  value?: string
  error?: string
  reasoningChunk?: string
  blocks?: ChatBlock[]
  fileChanges?: TurnFileChangesSummary
  contextUsage?: RuntimeContextUsage
}

export interface ChatChunkPayload {
  taskId?: string
  subtaskId?: string
  content: string
  offset?: number
  result?: ChatResultPayload
  deviceId?: string
}

export interface ChatDonePayload {
  taskId?: string
  subtaskId?: string
  offset?: number
  result: ChatResultPayload
  deviceId?: string
}

export interface ChatErrorPayload {
  taskId?: string
  subtaskId?: string
  error: string
  type?: string
  deviceId?: string
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

export type PluginInstallState =
  | 'not_installed'
  | 'installed'
  | 'update_available'
  | 'unavailable'
  | 'failed'
  | 'uninstalled'

export interface PluginSkillComponent {
  name: string
  description: string
  path: string
}

export interface PluginPathComponent {
  name: string
  path: string
}

export interface PluginMCPComponent {
  name: string
  server: Record<string, unknown>
}

export interface InstalledPluginComponents {
  skills: PluginSkillComponent[]
  commands: PluginPathComponent[]
  agents: PluginPathComponent[]
  hooks: PluginPathComponent[]
  mcps: PluginMCPComponent[]
  lsps: PluginPathComponent[]
  monitors: PluginPathComponent[]
  bins: PluginPathComponent[]
  settings?: Record<string, unknown> | null
}

export interface InstalledPluginSource {
  type: 'upload' | 'marketplace' | 'local'
  providerKey: string
  pluginKey: string
  catalogItemId?: string | null
  marketplace?: string | null
}

export interface InstalledPluginPackageRef {
  storageKey: string
  checksum: string
  sizeBytes: number
}

export interface InstalledPlugin {
  apiVersion: string
  kind: 'InstalledPlugin'
  metadata: Record<string, unknown>
  spec: {
    source: InstalledPluginSource
    displayName: string
    description: string
    version?: string | null
    author?: string | null
    installState: PluginInstallState
    enabled: boolean
    componentStates?: Record<string, boolean>
    manifest: Record<string, unknown>
    components: InstalledPluginComponents
    packageRef?: InstalledPluginPackageRef | null
    sourcePayload?: Record<string, unknown> | null
  }
  status: {
    state: string
  }
}

export interface InstalledPluginListResponse {
  items: InstalledPlugin[]
}

export interface InstalledPluginUpdateRequest {
  enabled?: boolean
  componentStates?: Record<string, boolean>
  displayName?: string
  description?: string
}

export type ChatBlockType =
  | 'text'
  | 'tool'
  | 'thinking'
  | 'plan'
  | 'error'
  | 'guidance'
  | 'file_changes'

export interface ChatBlock {
  id: string
  type: ChatBlockType
  content?: string
  tool_use_id?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_output?: unknown
  render_payload?: unknown
  renderPayload?: unknown
  file_changes?: TurnFileChangesSummary
  fileChanges?: TurnFileChangesSummary
  status?: 'generating_arguments' | 'pending' | 'streaming' | 'done' | 'error'
  timestamp?: number | string | null
  created_at?: number | string | null
  createdAt?: number | string | null
}

export interface ChatBlockCreatedPayload {
  taskId?: string
  subtaskId?: string
  block: ChatBlock
  deviceId?: string
}

export interface ChatBlockUpdatedPayload {
  taskId?: string
  subtaskId?: string
  blockId: string
  content?: string
  toolOutput?: unknown
  toolInput?: Record<string, unknown>
  fileChanges?: TurnFileChangesSummary
  status?: ChatBlock['status'] | 'running'
  deviceId?: string
}

export interface RuntimeSubagentActivityPayload {
  taskId?: string
  subtaskId?: string
  deviceId?: string
  agentPath: string
  agentId?: string
  agentName?: string
  agentThreadId?: string
  kind?: string
  status?: string
  occurredAtMs?: number
}

export interface RuntimeGoalEventPayload {
  taskId?: string
  subtaskId?: string
  deviceId?: string
  threadId?: string
  goal?: RuntimeGoal | null
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

export type ModelOptions = Record<string, string>

export type ModelCompatibilityDisabledReason =
  | 'missing_current_runtime_family'
  | 'missing_target_runtime_family'
  | 'unavailable'
  | 'runtime_family_mismatch'

export interface ModelRuntime {
  family?: string | null
  provider?: string | null
}

export interface UnifiedModel {
  name: string
  type: ModelType
  displayName?: string | null
  provider?: string | null
  modelId?: string | null
  namespace?: string
  config?: Record<string, unknown>
  runtime?: ModelRuntime | null
  isActive?: boolean
  compatibilityDisabled?: boolean
  compatibilityDisabledReason?: ModelCompatibilityDisabledReason
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

export type AttachmentStatus = 'uploading' | 'parsing' | 'ready' | 'failed'

export interface Attachment {
  id: number
  filename: string
  file_size: number
  mime_type: string
  status: AttachmentStatus
  text_length?: number | null
  text_preview?: string | null
  text_content?: string | null
  error_message?: string | null
  error_code?: string | null
  subtask_id?: string | null
  file_extension: string
  created_at: string
  local_preview_url?: string
  local_path?: string
}

export interface AttachmentUploadProgress {
  file: File
  progress: number
}

export interface MultiAttachmentUploadState {
  attachments: Attachment[]
  uploadingFiles: Map<string, AttachmentUploadProgress>
  errors: Map<string, string>
}
