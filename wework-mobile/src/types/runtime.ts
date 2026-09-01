export type DeviceStatus = 'online' | 'offline' | 'busy'
export type ModelType = 'public' | 'user' | 'group' | 'runtime' | string
export type ModelOptions = Record<string, string>

export interface UnifiedModel {
  name: string
  type: ModelType
  displayName?: string | null
  provider?: string | null
  modelId?: string | null
  contextWindow?: number | null
  maxOutputTokens?: number | null
  namespace?: string
  resourceUserId?: number
  config?: Record<string, unknown>
  runtime?: { family?: string | null; provider?: string | null } | null
  isActive?: boolean
  compatibilityDisabled?: boolean
  compatibilityDisabledReason?: string
}

export interface UnifiedModelListResponse {
  data: UnifiedModel[]
}

export interface ModelSelectionConfig {
  modelName: string
  modelType?: ModelType | null
  options: ModelOptions
}

export interface ModelExecutionFields {
  modelId: string
  modelType: ModelType
  modelOptions: ModelOptions
}

export interface DeviceInfo {
  id: number
  device_id: string
  name: string
  status: DeviceStatus
  device_type?: string | null
  capabilities?: string[] | null
}

export interface DeviceListResponse {
  items: DeviceInfo[]
}

export interface RuntimeTaskAddress {
  deviceId: string
  taskId: string
  runtime?: string
  workspacePath?: string | null
  workspaceKind?: string | null
}

export interface RuntimeTaskSummary {
  taskId: string
  title: string
  runtime: string
  workspacePath: string
  workspaceKind?: string | null
  updatedAt?: string | number | null
  createdAt?: string | number | null
  running?: boolean
  status?: string | null
}

export interface RuntimeDeviceWorkspace {
  id?: number | null
  projectId?: number | null
  deviceId: string
  deviceName: string
  deviceStatus: DeviceStatus | string
  available: boolean
  workspacePath: string
  workspaceKind?: string | null
  label?: string | null
  tasks: RuntimeTaskSummary[]
}

export interface RuntimeProjectRef {
  id?: number
  key: string
  name: string
}

export interface RuntimeProjectWork {
  project: RuntimeProjectRef
  deviceWorkspaces: RuntimeDeviceWorkspace[]
}

export interface RuntimeWorkListResponse {
  projects: RuntimeProjectWork[]
  chats: RuntimeDeviceWorkspace[]
  totalTasks: number
}

export interface RuntimeTranscriptMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool' | string
  content: string
  clientUserMessageId?: string | null
  client_user_message_id?: string | null
  subtaskId?: string | number | null
  turnId?: string | null
  turn_id?: string | null
  status?: string | null
  error?: string | null
  errorType?: string | null
  error_type?: string | null
  blocks?: RuntimeChatBlock[] | null
  fileChanges?: RuntimeFileChangesSummary | null
  file_changes?: RuntimeFileChangesSummary | null
  createdAt?: string | number | null
  created_at?: string | number | null
  completedAt?: string | number | null
  completed_at?: string | number | null
}

export interface RuntimeTranscriptResponse {
  taskId: string
  workspacePath: string
  runtime: string
  title?: string | null
  running?: boolean
  messages: RuntimeTranscriptMessage[]
  hasMoreBefore?: boolean
  beforeCursor?: string | null
}

export interface RuntimeCreateRequest {
  schemaVersion: 2
  deviceId: string
  workspacePath: string
  taskId: string
  runtime: 'codex'
  message: string
  clientUserMessageId: string
  title: string
  modelId: string
  modelType: ModelType
  modelOptions: ModelOptions
  attachmentIds?: number[]
  initialGoal?: RuntimeGoalCreateInput
  execution?: {
    workspace: { source: 'git_worktree'; branch?: string }
  }
}

export interface RuntimeGoalCreateInput {
  objective: string
  status?: 'active' | 'paused' | 'complete' | 'budgetLimited'
  tokenBudget?: number | null
}

export interface RuntimeAttachment {
  id: number
  filename: string
  fileSize: number
  mimeType: string
}

export interface RuntimeUploadAsset {
  uri: string
  name: string
  mimeType: string
  size?: number
}

export interface RuntimeComposerApp {
  id: string
  name: string
  description?: string | null
  logoUrl?: string | null
  reference: string
}

export interface RuntimeInstalledPlugin {
  metadata: {
    name?: string
    namespace?: string
  }
  spec: {
    source: {
      pluginKey: string
      catalogItemId?: string | null
      marketplace?: string | null
    }
    displayName: string
    description?: string
    installState: string
    enabled: boolean
    sourcePayload?: Record<string, unknown> | null
    components?: {
      apps?: RuntimePluginComponent[]
      templates?: RuntimePluginComponent[]
      commands?: RuntimePluginComponent[]
      skills?: RuntimePluginComponent[]
    }
    interface?: {
      logo?: string | null
      logoDark?: string | null
    } | null
  }
}

export interface RuntimePluginComponent {
  name: string
  path?: string | null
  description?: string | null
  materializedAppIds?: string[]
}

export interface RuntimeCreateResponse {
  accepted: boolean
  deviceId: string
  taskId: string
  workspacePath: string
  runtime: string
  status?: 'queued' | 'running'
  error?: string | null
}

export interface RuntimeSendResponse {
  accepted: boolean
  taskId: string
  error?: string | null
}

export interface RuntimeTaskCancelResponse {
  accepted: boolean
  taskId?: string
  workspacePath?: string | null
  error?: string | null
}

export interface RuntimeWorkspaceOpenResponse {
  accepted: boolean
  deviceId: string
  workspacePath: string
  runtime: string
  error?: string | null
}

export interface RuntimeWorktreePreflightResponse {
  success: boolean
  deviceId: string
  supported: boolean
  sourcePath: string
  sourceExists: boolean
  sourceDirectory: boolean
  gitRepository: boolean
  writable: boolean
  gitRef?: string | null
}

export interface ConversationItem {
  address: RuntimeTaskAddress
  title: string
  deviceName: string
  projectName: string | null
  updatedAt: number
  running: boolean
}

export interface ChatMessage {
  id: string
  taskId?: string
  subtaskId?: string
  turnId?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  textItems?: ChatTextItem[]
  blocks?: ChatProcessingBlock[]
  fileChanges?: ChatFileChangesSummary
  streamingThinkingContent?: string
  status: 'pending' | 'streaming' | 'completed' | 'failed'
  createdAt: number
  completedAt?: number
  error?: string
  errorType?: string
}

export interface ChatTextItem {
  id: string
  content: string
  streamOffset?: number
}

export type ChatBlockStatus = 'generating_arguments' | 'pending' | 'streaming' | 'done' | 'error'

interface ChatProcessingBlockBase {
  id: string
  subtaskId: string
  status: ChatBlockStatus
  createdAt: number
  completedAt?: number
  durationMs?: number
}

export interface ChatToolBlock extends ChatProcessingBlockBase {
  type: 'tool'
  toolName: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
  renderPayload?: unknown
}

export interface ChatNarrativeBlock extends ChatProcessingBlockBase {
  type: 'thinking' | 'text' | 'plan' | 'error' | 'guidance'
  content: string
}

export type ChatProcessingBlock = ChatToolBlock | ChatNarrativeBlock

export interface ChatFileChangeItem {
  path: string
  oldPath?: string
  changeType: 'created' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  binary: boolean
}

export interface ChatFileChangesSummary {
  fileCount: number
  additions: number
  deletions: number
  files: ChatFileChangeItem[]
}

export interface RuntimeFileChangesSummary {
  file_count?: number
  fileCount?: number
  additions?: number
  deletions?: number
  files?: Array<{
    path?: string
    old_path?: string | null
    oldPath?: string | null
    change_type?: string
    changeType?: string
    additions?: number
    deletions?: number
    binary?: boolean
  }>
}

export interface RuntimeChatBlock {
  id?: string
  type?: string
  content?: string
  text?: string
  tool_use_id?: string
  toolUseId?: string
  tool_name?: string
  toolName?: string
  tool_input?: Record<string, unknown>
  toolInput?: Record<string, unknown>
  tool_output?: unknown
  toolOutput?: unknown
  render_payload?: unknown
  renderPayload?: unknown
  status?: string
  timestamp?: string | number | null
  created_at?: string | number | null
  createdAt?: string | number | null
  completed_at?: string | number | null
  completedAt?: string | number | null
  duration_ms?: number | null
  durationMs?: number | null
  [key: string]: unknown
}
