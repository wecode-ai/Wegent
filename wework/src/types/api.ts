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

export type ModelType = 'public' | 'user' | 'group'

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
  device_type?: 'local' | 'cloud' | string
  bind_shell?: 'claudecode' | 'openclaw' | string
}

export interface ProjectTask {
  id: number
  task_id: number
  task_title?: string
  task_status?: string
  title?: string
  status?: string
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
  device_id?: string | null
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
  task_id: number
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
  origin?: 'local' | 'wegent' | string
  plugin_name?: string | null
  mtime?: number
}

export interface DeviceCommandResponse {
  success: boolean
  exit_code?: number | null
  stdout: string | string[] | LocalDeviceSkill[]
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
  task_id?: number
  role: string
  prompt?: string
  result?: unknown
  status: string
  message_id?: number
  created_at: string
  updated_at?: string
  contexts?: TaskContextData[]
  attachments?: Attachment[]
  sender_user_name?: string
}

export interface TaskDetail extends Task {
  subtasks?: Subtask[]
}

export interface CreateProjectConversationRequest {
  prompt: string
  title?: string
  new_session?: boolean
}

export interface CreateProjectConversationResponse {
  task_id: number
  project_id: number
  task: unknown
}

export interface ProjectDeviceSessionResponse {
  session_id: string
  project_id: number
  device_id: string
  type: 'terminal' | 'code_server'
  path: string
  url: string
  expires_at?: string | null
}

export interface ChatSendPayload {
  task_id?: number
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
  additional_skills?: SkillRef[]
}

export interface ChatSendAck {
  success?: boolean
  task_id?: number
  error?: string
}

export interface ChatGuidePayload {
  task_id: number
  subtask_id: number
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
  subtask_id: number
  partial_content?: string
  shell_type?: string
}

export interface ChatCancelAck {
  success?: boolean
  error?: string
}

export interface ChatStartPayload {
  task_id: number
  subtask_id: number
  bot_name?: string
  shell_type?: string
  message_id?: number
}

export type ChatResultPayload = Record<string, unknown> & {
  value?: string
  error?: string
  reasoning_chunk?: string
  blocks?: ChatBlock[]
}

export interface ChatChunkPayload {
  task_id?: number
  subtask_id: number
  content: string
  offset: number
  result?: ChatResultPayload
}

export interface ChatDonePayload {
  task_id?: number
  subtask_id: number
  offset: number
  result: ChatResultPayload
  message_id?: number
}

export interface ChatErrorPayload {
  task_id?: number
  subtask_id: number
  error: string
  message_id?: number
}

export interface TaskJoinResponse {
  streaming?: {
    subtask_id: number
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

export type ChatBlockType = 'text' | 'tool' | 'thinking' | 'error' | 'guidance'

export interface ChatBlock {
  id: string
  type: ChatBlockType
  content?: string
  tool_use_id?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_output?: unknown
  status?: 'generating_arguments' | 'pending' | 'streaming' | 'done' | 'error'
  timestamp?: number
}

export interface ChatBlockCreatedPayload {
  task_id: number
  subtask_id: number
  block: ChatBlock
}

export interface ChatBlockUpdatedPayload {
  task_id: number
  subtask_id: number
  block_id: string
  content?: string
  tool_output?: unknown
  tool_input?: Record<string, unknown>
  status?: ChatBlock['status'] | 'running'
}

export interface ChatGuidanceQueuedPayload {
  task_id: number
  subtask_id: number
  team_id?: number
  user_id?: number
  guidance_id: string
  client_guidance_id?: string
  message?: string
  content?: string
  created_at?: string
}

export interface ChatGuidanceAppliedPayload {
  task_id: number
  subtask_id: number
  guidance_id: string
  client_guidance_id?: string
  applied_at: string
}

export interface ChatGuidanceExpiredPayload {
  task_id: number
  subtask_id: number
  guidance_ids: string[]
}

export type ModelOptions = Record<string, string>

export type ModelCompatibilityDisabledReason =
  | 'missing_current_runtime_family'
  | 'missing_target_runtime_family'
  | 'runtime_family_mismatch'

export interface ModelRuntime {
  family?: string | null
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
  error_message?: string | null
  error_code?: string | null
  subtask_id?: number | null
  file_extension: string
  created_at: string
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
