import type {
  Attachment,
  CodexMemoryCitation,
  CodexReference,
  DeviceInfo,
  ProjectWithTasks,
  RuntimeContextUsage,
  RuntimeTaskAddress,
  RuntimeTurnNavigationItem,
  RuntimeWorkListResponse,
  Team,
  TurnFileChangesSummary,
  User,
} from './api'
import type {
  BaseWorkbenchProcessingBlock,
  WorkbenchMessage as CoreWorkbenchMessage,
  WorkbenchMessageRole,
  WorkbenchMessageStatus,
  WorkbenchFileChangesBlock,
  WorkbenchPlanBlock,
  WorkbenchProcessingBlock,
  WorkbenchThinkingBlock,
  WorkbenchTextBlock,
  WorkbenchToolBlock,
  WorkbenchToolBlockStatus,
} from '@wegent/chat-core'
import type { CodeCommentContext } from './workspace-files'

export type MessageRole = WorkbenchMessageRole
export type MessageStatus = WorkbenchMessageStatus

export type ToolBlockStatus = WorkbenchToolBlockStatus

export type BaseProcessingBlock = BaseWorkbenchProcessingBlock

export type ToolBlock = WorkbenchToolBlock

export type ThinkingBlock = WorkbenchThinkingBlock

export type TextBlock = WorkbenchTextBlock

export type PlanBlock = WorkbenchPlanBlock

export type FileChangesBlock = WorkbenchFileChangesBlock<TurnFileChangesSummary>

export type ProcessingBlock = WorkbenchProcessingBlock<TurnFileChangesSummary>

export type MessageSource = NonNullable<CoreWorkbenchMessage['source']>

export type RuntimeWorkbenchMessageStatus = WorkbenchMessageStatus | 'cancelled'

export type RuntimeSubagentStatusState = 'running' | 'done' | 'interrupted'

export interface RuntimeSubagentStatus {
  id: string
  agentId: string
  agentPath: string
  agentName: string
  status: RuntimeSubagentStatusState
  kind?: string
  updatedAtMs?: number | null
}

export type WorkbenchMessage = Omit<
  CoreWorkbenchMessage<Attachment, TurnFileChangesSummary>,
  'blocks'
> & {
  blocks?: ProcessingBlock[]
  runtimeMessageIndex?: number | null
  runtimeStatus?: RuntimeWorkbenchMessageStatus | null
  completedAt?: string | number | null
  stoppedNotice?: boolean | null
  runtimeGoalRequest?: boolean | null
  runtimeGuidance?: boolean | null
  runtimeGuidanceSplitBefore?: boolean | null
  runtimeGuidanceContinuation?: boolean | null
  codeComments?: CodeCommentContext[] | null
  references?: CodexReference[] | null
  memoryCitations?: CodexMemoryCitation[] | null
}

export type QueuedMessageStatus = 'queued' | 'sending' | 'failed'
export type GuidanceMessageStatus = 'sending' | 'queued' | 'applied' | 'expired' | 'failed'

export interface QueuedWorkbenchMessage {
  id: string
  content: string
  status: QueuedMessageStatus
  createdAt: string
  error?: string
  notice?: string
}

export interface GuidanceWorkbenchMessage {
  id: string
  content: string
  status: GuidanceMessageStatus
  createdAt: string
  error?: string
}

export interface RuntimePaneTranscript {
  messages: WorkbenchMessage[]
  running?: boolean
  contextUsage?: RuntimeContextUsage | null
  turnNavigation?: RuntimeTurnNavigationItem[]
  fullContent?: boolean
  rangeStart?: number | null
  rangeEnd?: number | null
  hasMoreBefore?: boolean
  beforeCursor?: string | null
  hasMoreAfter?: boolean
  afterCursor?: string | null
}

export interface RuntimePaneTranscriptLoadOptions {
  limit?: number
  beforeCursor?: string | null
  afterCursor?: string | null
  refresh?: boolean
  includeFullContent?: boolean
}

export type RuntimeTranscriptLoader = (
  address: RuntimeTaskAddress,
  options?: RuntimePaneTranscriptLoadOptions
) => Promise<RuntimePaneTranscript>

export type CloudWorkCheckKey = 'teams' | 'devices' | 'runtimeWork'
export type CloudWorkCheckStatus = 'idle' | 'syncing' | 'available' | 'empty' | 'unavailable'
export type CloudWorkAvailability = 'idle' | 'syncing' | 'available' | 'empty' | 'unavailable'
export type CloudSyncTrigger =
  | 'bootstrap'
  | 'manual-refresh'
  | 'cloud-connection'
  | 'device-event'
  | 'runtime-event'
  | 'poll'
export type CloudRuntimeAvailability =
  | 'idle'
  | 'syncing'
  | 'ready'
  | 'partial'
  | 'stale'
  | 'unavailable'
export type SyncCheckStateStatus = 'idle' | 'syncing' | 'success' | 'empty' | 'failed' | 'stale'

export interface SyncCheckState {
  status: SyncCheckStateStatus
  updatedAt: string | null
  error: string | null
}

export interface CloudRuntimeSnapshot {
  revision: number
  devices: DeviceInfo[]
  runtimeWork: RuntimeWorkListResponse
  teams: Team[]
  fetchedAt: string | null
  checks: Record<CloudWorkCheckKey, SyncCheckState>
}

export interface CloudRuntimeState {
  availability: CloudRuntimeAvailability
  current: CloudRuntimeSnapshot | null
  lastGood: CloudRuntimeSnapshot | null
  inFlightRevision: number | null
  lastTrigger: CloudSyncTrigger | null
  nextRevision: number
}

export interface CloudWorkStatus {
  availability: CloudWorkAvailability
  checks: Record<CloudWorkCheckKey, CloudWorkCheckStatus>
  error: string | null
  updatedAt: string | null
}

export interface WorkbenchState {
  user: User | null
  defaultTeam: Team | null
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  runtimeWork: RuntimeWorkListResponse | null
  currentProject: ProjectWithTasks | null
  currentRuntimeTask: RuntimeTaskAddress | null
  standaloneChatKey: number
  selectedDeviceWorkspaceId: number | null
  pendingProjectWorkspaceProjectId: number | null
  standaloneDeviceId: string | null
  standaloneWorkspacePath: string | null
  isBootstrapping: boolean
  error: string | null
}
