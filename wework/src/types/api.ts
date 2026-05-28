export interface User {
  id: number
  user_name: string
  email: string
}

export interface Team {
  id: number
  name: string
  displayName?: string | null
  is_active: boolean
  default_for_modes?: string[]
  recommended_mode?: 'chat' | 'code' | 'both'
}

export interface ProjectConfig {
  mode?: 'workspace' | string
  path?: string
  device_id?: string
}

export interface ProjectTask {
  id: number
  task_id: number
  title?: string
  created_at?: string
  updated_at?: string
  task_type?: string
}

export interface ProjectWithTasks {
  id: number
  name: string
  description?: string | null
  color?: string | null
  config?: ProjectConfig | null
  tasks?: ProjectTask[]
}

export interface ProjectListResponse {
  items: ProjectWithTasks[]
}

export interface Task {
  id: number
  title: string
  status: string
  task_type?: 'chat' | 'code' | 'task' | 'knowledge' | 'video' | 'image'
  team_id?: number
  created_at: string
  updated_at?: string
  is_group_chat?: boolean
}

export interface TaskListResponse {
  total: number
  items: Task[]
}

export interface TaskContextData {
  id: number
  context_type: 'attachment' | 'knowledge_base'
  name: string
  status: string
}

export interface Subtask {
  id: number
  role: string
  prompt?: string
  result?: unknown
  status: string
  created_at: string
  updated_at?: string
  contexts?: TaskContextData[]
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

export interface ChatSendPayload {
  task_id?: number
  team_id: number
  message: string
  title?: string
  task_type?: 'chat' | 'code' | 'task' | 'knowledge' | 'video' | 'image'
  project_id?: number
}

export interface ChatSendAck {
  success: boolean
  task_id?: number
  error?: string
}

export interface ChatStartPayload {
  task_id: number
  subtask_id: number
  bot_name?: string
  shell_type?: string
  message_id?: number
}

export interface ChatChunkPayload {
  task_id?: number
  subtask_id: number
  content: string
  offset: number
}

export interface ChatDonePayload {
  task_id?: number
  subtask_id: number
  offset: number
  result: Record<string, unknown> & { value?: string; error?: string }
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
