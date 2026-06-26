import type {
  Attachment,
  CodexContextEvent,
  CodexMemoryCitation,
  CodexReference,
  DeviceInfo,
  ProjectWithTasks,
  RuntimeTaskAddress,
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
  WorkbenchProcessingBlock,
  WorkbenchThinkingBlock,
  WorkbenchTextBlock,
  WorkbenchToolBlock,
  WorkbenchToolBlockStatus,
} from '@wegent/chat-core'

export type MessageRole = WorkbenchMessageRole
export type MessageStatus = WorkbenchMessageStatus

export type ToolBlockStatus = WorkbenchToolBlockStatus

export type BaseProcessingBlock = BaseWorkbenchProcessingBlock

export type ToolBlock = WorkbenchToolBlock

export type ThinkingBlock = WorkbenchThinkingBlock

export type TextBlock = WorkbenchTextBlock

export type FileChangesBlock = WorkbenchFileChangesBlock<TurnFileChangesSummary>

export type ProcessingBlock = WorkbenchProcessingBlock<TurnFileChangesSummary>

export type MessageSource = NonNullable<CoreWorkbenchMessage['source']>

export type RuntimeWorkbenchMessageStatus = WorkbenchMessageStatus | 'cancelled'

export type WorkbenchMessage = Omit<
  CoreWorkbenchMessage<Attachment, TurnFileChangesSummary>,
  'blocks'
> & {
  blocks?: ProcessingBlock[]
  runtimeStatus?: RuntimeWorkbenchMessageStatus | null
  references?: CodexReference[] | null
  memoryCitations?: CodexMemoryCitation[] | null
  contextEvents?: CodexContextEvent[] | null
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

export type CloudWorkCheckKey = 'teams' | 'devices' | 'runtimeWork'
export type CloudWorkCheckStatus = 'idle' | 'syncing' | 'available' | 'empty' | 'unavailable'
export type CloudWorkAvailability = 'idle' | 'syncing' | 'available' | 'empty' | 'unavailable'

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
  selectedDeviceWorkspaceId: number | null
  pendingProjectWorkspaceProjectId: number | null
  standaloneDeviceId: string | null
  standaloneWorkspacePath: string | null
  input: string
  isBootstrapping: boolean
  isSending: boolean
  error: string | null
}
