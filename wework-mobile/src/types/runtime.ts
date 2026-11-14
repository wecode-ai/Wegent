export type DeviceStatus = 'online' | 'offline' | 'busy'
import type { ModelType, ModelOptions, UnifiedModel } from '../../../packages/chat-core/src/models'
import type { Attachment, TurnFileChangesSummary } from '../../../packages/chat-core/src/runtime'
export type { Attachment }
export type { ModelType, ModelOptions, UnifiedModel }
export type { RunnerModel } from '../../../packages/collaboration/src/agent-form/runnerRouting'
export type {
  RequestUserInputPayload,
  RequestUserInputResponse,
} from '../../../packages/chat-core/src/runtime'

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
  execution_target_id?: string | null
  runtime_instance_id?: string | null
  app_device_id?: string | null
  socket_device_id?: string | null
  runtime_routes?: import('../../../packages/chat-core/src/execution-project').DeviceRuntimeRoute[]
  name: string
  status: DeviceStatus
  device_type: 'local' | 'app' | 'cloud' | 'remote'
  bind_shell: 'claudecode' | 'openclaw'
  capabilities?: string[] | null
  runtime_features?: {
    schemaVersion: number
    remoteTaskAccess?: { version: number; enabled: boolean; taskCreation?: boolean } | null
    [feature: string]: unknown
  } | null
}

export interface DeviceListResponse {
  items: DeviceInfo[]
}

export type RuntimeTaskAddress =
  import('../../../packages/chat-core/src/runtime').RuntimeTaskAddress

export interface RuntimeTaskPinRequest {
  deviceId: string
  threadId: string
  pinned: boolean
  beforeThreadId?: string | null
}

export interface RuntimeSidebarMutationResponse {
  accepted: boolean
  deviceId: string
  error?: string | null
}

export interface RuntimeTaskRenameRequest {
  address: RuntimeTaskAddress
  title: string
}

export interface RuntimeTaskArchiveResponse {
  accepted: boolean
  taskId: string
  workspacePath?: string | null
  error?: string | null
}

export interface RuntimeTaskSummary {
  taskId: string
  runtimeHandle?: Record<string, unknown> | null
  optimistic?: boolean
  threadId?: string | null
  title: string
  runtime: string
  workspacePath: string
  workspaceKind?: string | null
  worktreeId?: string | null
  gitInfo?: Record<string, unknown> | null
  updatedAt?: string | number | null
  createdAt?: string | number | null
  running?: boolean
  status?: string | null
  pinned?: boolean
  pinnedOrder?: number | null
  sidebarOrder?: number | null
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
  worktreeId?: string | null
  label?: string | null
  workspaceSource?: string | null
  remoteHostId?: string | null
  mapped?: boolean
  tasks: RuntimeTaskSummary[]
}

export interface RuntimeProjectRef {
  id?: number
  key: string
  name: string
  stateDeviceId?: string | null
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

export interface RuntimeTranscriptMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool' | string
  content: string
  attachments?: Attachment[]
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
  runtimeItems?: (
    | { id: string; type: 'assistant_text'; content: string; createdAt?: string | number | null }
    | { id: string; type: 'block'; block: RuntimeChatBlock }
  )[]
  fileChanges?: RuntimeFileChangesSummary | null
  file_changes?: RuntimeFileChangesSummary | null
  createdAt?: string | number | null
  created_at?: string | number | null
  completedAt?: string | number | null
  completed_at?: string | number | null
}

export interface RuntimeTranscriptResponse {
  taskId: string
  threadId?: string | null
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
  workspacePath?: string
  standaloneChatWorkspace?: boolean
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
  sourceWorkspacePath: string
  title: string
  deviceName: string
  projectName: string | null
  updatedAt: number
  running: boolean
  pinned?: boolean
  pinnedOrder?: number | null
}

export interface ChatMessage {
  pendingDelivery?: boolean
  id: string
  taskId?: string
  subtaskId?: string
  turnId?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  attachments?: Attachment[]
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
  parentToolUseId?: string
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

export interface ChatFileChangesBlock extends ChatProcessingBlockBase {
  type: 'file_changes'
  fileChanges: ChatFileChangesSummary
}

export type ChatSubagentBlock =
  import('../../../packages/chat-core/src/runtime-conversation').SubagentBlock

export type ChatProcessingBlock =
  ChatToolBlock | ChatNarrativeBlock | ChatFileChangesBlock | ChatSubagentBlock

export interface ChatFileChangeItem {
  path: string
  oldPath?: string
  changeType: 'created' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  binary: boolean
}

export interface ChatFileChangesSummary {
  source?: TurnFileChangesSummary
  fileCount: number
  additions: number
  deletions: number
  files: ChatFileChangeItem[]
}

export interface RuntimeFileChangesSummary extends Partial<Omit<TurnFileChangesSummary, 'files'>> {
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
  file_changes?: RuntimeFileChangesSummary
  fileChanges?: RuntimeFileChangesSummary
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
