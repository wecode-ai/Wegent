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

export interface ProjectConfig {
  mode?: 'workspace' | string
  path?: string
  device_id?: string
  execution?: ProjectExecutionConfig | null
  workspace?: ProjectWorkspaceConfig | null
}

export interface DeviceInfo {
  id: number
  device_id: string
  name: string
  status: 'online' | 'offline' | 'busy'
  is_default: boolean
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
  config?: ProjectConfig
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
  created_at: string
  updated_at?: string
  is_group_chat?: boolean
  model_id?: string | null
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

export interface DeviceCommandResponse {
  success: boolean
  exit_code?: number | null
  stdout: string | string[]
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
  device_id?: string
  model_id?: string
  force_override_bot_model?: string
  force_override_bot_model_type?: string
  attachment_ids?: number[]
  additional_skills?: SkillRef[]
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

export type ModelType = 'public' | 'user' | 'group'

export interface UnifiedModel {
  name: string
  type: ModelType
  displayName?: string | null
  provider?: string | null
  modelId?: string | null
  namespace?: string
  config?: Record<string, unknown>
  isActive?: boolean
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
