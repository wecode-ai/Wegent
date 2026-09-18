import type { ModelOptions, ModelType } from './models'
import type {
  ModelSelectionConfig,
  RuntimeGoalStatus,
  RuntimeSupervisorState,
} from './runtime-stream-types'
import type {
  RuntimeTaskAddress,
  RuntimeName,
  RuntimeMessageSource,
  RequestUserInputResponse,
  Attachment,
} from './runtime'

export type RuntimeAdditionalContextKind = 'application' | 'untrusted'

export interface RuntimeAdditionalContextEntry {
  value: string
  kind: RuntimeAdditionalContextKind
}

export type RuntimeAdditionalContext = Record<string, RuntimeAdditionalContextEntry>

export interface RuntimeTaskSummary {
  taskId: string
  threadId?: string | null
  workspacePath: string
  workspaceKind?: 'workspace' | 'worktree' | 'chat' | string | null
  worktreeId?: string | null
  gitInfo?: Record<string, unknown> | null
  title: string
  runtime: RuntimeName
  createdAt?: string | number | null
  updatedAt?: string | number | null
  recencyAt?: string | number | null
  completedAt?: string | number | null
  running?: boolean
  continuable?: boolean
  threadStatus?: 'notLoaded' | 'idle' | 'systemError' | 'active' | string
  turnStatus?: 'inProgress' | 'completed' | 'interrupted' | 'failed' | null
  pinned?: boolean
  pinnedOrder?: number | null
  sidebarOrder?: number | null
  status?: string | null
  queuePosition?: number | null
  goalStatus?: RuntimeGoalStatus | null
  goalExecutionStatus?: RuntimeGoalExecutionStatus | null
  optimistic?: boolean
  cachedProjection?: boolean
  error?: string | null
  runtimeHandle?: Record<string, unknown> | null
  modelSelection?: ModelSelectionConfig | null
  projectPluginIds?: string[]
  parent?: Record<string, unknown> | null
  children?: Record<string, unknown>[]
  supervisor?: RuntimeSupervisorState | null
}

export interface RuntimeProjectRef {
  key: string
  sidebarStateKey?: string | null
  id?: number
  name: string
  description?: string | null
  color?: string | null
  kind?: 'local' | 'remote' | string
  source?: 'legacy_root' | 'local_project' | 'remote_project' | string
  stateDeviceId?: string | null
  roots?: RuntimeProjectRoot[]
  sidebarOrder?: number | null
  pinned?: boolean
  pinnedOrder?: number | null
  active?: boolean
  appearance?: RuntimeProjectAppearance | null
  defaultProjectSpace?: RuntimeProjectSpaceRef | null
  aiSettings?: RuntimeProjectAiSettings | null
}

export interface RuntimeProjectSpaceRef {
  projectStore: 'local' | 'backend'
  projectId: string
}

export interface RuntimeProjectAiSettings {
  instructions?: string
  modelSelection?: ModelSelectionConfig | null
  plugins?: RuntimeProjectPluginRef[]
  quickPhrases?: RuntimeProjectQuickPhrase[]
}

export interface RuntimeProjectQuickPhrase {
  id: string
  title: string
  content: string
  mode: 'normal' | 'plan' | 'goal'
}

export interface RuntimeProjectPluginRef {
  id: string
  pluginName: string
  marketplaceId: string
  displayName: string
}

export interface RuntimeProjectRoot {
  kind: 'local' | string
  path: string
  label?: string | null
}

export interface RuntimeProjectAppearance {
  color?: 'black' | 'blue' | 'green' | 'orange' | 'pink' | 'purple' | 'red' | 'yellow' | string
  marker?:
    | { kind: 'icon'; icon: string }
    | { kind: 'emoji'; emoji: string }
    | Record<string, unknown>
}

export interface RuntimeDeviceWorkspace {
  id?: number | null
  projectId?: number | null
  deviceId: string
  deviceName?: string | null
  deviceStatus?: string | null
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

export interface RuntimeSendRequest {
  address: RuntimeTaskAddress
  message: string
  clientUserMessageId?: string
  retrySourceTurnId?: string
  initialGoal?: RuntimeGoalCreateInput | null
  ephemeral?: boolean
  modelId?: string
  modelType?: ModelType | null
  modelOptions?: ModelOptions
  modelSelection?: ModelSelectionConfig | null
  collaborationMode?: string
  attachmentIds?: number[]
  attachments?: Attachment[]
  source?: RuntimeMessageSource | null
  cloudProjectId?: string
  origin?: RuntimeTaskOrigin
  requestUserInputResponse?: RequestUserInputResponse
  request_user_input_response?: RequestUserInputResponse
  additionalContext?: RuntimeAdditionalContext
  additional_context?: RuntimeAdditionalContext
}

export interface RuntimeSendResponse {
  accepted: boolean
  taskId: string
  status?: 'queued' | 'running'
  queuePosition?: number | null
  turnId?: string
  turn_id?: string
  compactionItemId?: string
  compaction_item_id?: string
  error?: string | null
}

export interface RuntimeGuidanceRequest {
  address: RuntimeTaskAddress
  message: string
  attachmentIds?: number[]
  attachments?: Attachment[]
  clientGuidanceId?: string
  client_guidance_id?: string
  additionalContext?: RuntimeAdditionalContext
  additional_context?: RuntimeAdditionalContext
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

export type RuntimeGoalExecutionStatus = 'running' | 'recovering' | 'needsAttention'

export interface RuntimeGoalCreateInput {
  objective: string
  status?: RuntimeGoalStatus | null
  tokenBudget?: number | null
}

export type RuntimeTaskOrigin = {
  type: 'board_comment' | 'board_task' | 'project_automation'
  cloudProjectId: string
  loopItemId: string
  rootCommentId?: string
  [key: string]: unknown
}

export interface RuntimeTaskCancelResponse {
  accepted: boolean
  taskId?: string
  workspacePath?: string | null
  error?: string | null
}

/** Canonical creation fields shared by browser comments and the desktop workbench. */
export interface RuntimeTaskCreateIntent {
  schemaVersion?: 1 | 2 | 3
  runtime: RuntimeName
  message: string
  taskId?: string
  deviceId?: string
  projectId?: number
  deviceWorkspaceId?: number
  workspacePath?: string
  standaloneChatWorkspace?: boolean
  runtimeProjectKey?: string
  runtimeProjectName?: string
  runtimeWorkspaceRoots?: string[]
  clientUserMessageId?: string
  modelId?: string
  modelType?: ModelType | null
  modelOptions?: ModelOptions
  modelSelection?: ModelSelectionConfig | null
  attachments?: Attachment[]
  attachmentIds?: number[]
  cloudProjectId?: string
  origin?: RuntimeTaskOrigin
  additionalContext?: RuntimeAdditionalContext
}

export interface RuntimeTaskCreateResponse {
  accepted: boolean
  deviceId: string
  taskId: string
  workspacePath: string
  runtime: RuntimeName
  runtimeHandle?: Record<string, unknown> | null
  status?: 'queued' | 'running'
  queuePosition?: number | null
  error?: string | null
}

export interface RuntimeGoalGetRequest {
  address: RuntimeTaskAddress
}

export interface RuntimeGoalGetResponse {
  accepted: boolean
  taskId: string
  goal: import('./runtime-stream-types').RuntimeGoal | null
  error?: string | null
}
