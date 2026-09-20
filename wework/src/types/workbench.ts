export type {
  MessageRole,
  MessageStatus,
  ToolBlockStatus,
  BaseProcessingBlock,
  ToolBlock,
  ThinkingBlock,
  TextBlock,
  PlanBlock,
  SubagentBlock,
  FileChangesBlock,
  ProcessingBlock,
  MessageSource,
  RuntimeWorkbenchMessageStatus,
  RuntimeSubagentStatusState,
  RuntimeSubagentStatus,
  WorkbenchMessage,
  RuntimeAssistantDisplayItem,
  RuntimeConversationTurn,
  RuntimeConversationItem,
} from '@wegent/chat-core/runtime-conversation'

import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  Team,
  User,
} from './api'

export type {
  QueuedMessageStatus,
  GuidanceMessageStatus,
  QueuedWorkbenchMessage,
  RuntimePaneQueuedMessage,
  GuidanceWorkbenchMessage,
} from '@wegent/chat-core/conversation-queue'

export type { RuntimePaneTranscript } from '@wegent/chat-core/runtime-transcript-page'
import type { RuntimePaneTranscript } from '@wegent/chat-core/runtime-transcript-page'
export interface RuntimePaneTranscriptLoadOptions {
  limit?: number
  beforeCursor?: string | null
  afterCursor?: string | null
  refresh?: boolean
  includeFullContent?: boolean
  navigationOnly?: boolean
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
