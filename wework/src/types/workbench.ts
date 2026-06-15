import type {
  Attachment,
  DeviceInfo,
  ProjectWithTasks,
  Task,
  Team,
  TurnFileChangesSummary,
  User,
} from './api'
import type {
  BaseWorkbenchProcessingBlock,
  WorkbenchMessage as CoreWorkbenchMessage,
  WorkbenchMessageRole,
  WorkbenchMessageStatus,
  WorkbenchProcessingBlock,
  WorkbenchThinkingBlock,
  WorkbenchToolBlock,
  WorkbenchToolBlockStatus,
} from '@wegent/chat-core'

export type MessageRole = WorkbenchMessageRole
export type MessageStatus = WorkbenchMessageStatus

export type ToolBlockStatus = WorkbenchToolBlockStatus

export type BaseProcessingBlock = BaseWorkbenchProcessingBlock

export type ToolBlock = WorkbenchToolBlock

export type ThinkingBlock = WorkbenchThinkingBlock

export type ProcessingBlock = WorkbenchProcessingBlock

export type WorkbenchMessage = CoreWorkbenchMessage<Attachment, TurnFileChangesSummary>

export type QueuedMessageStatus = 'queued' | 'sending' | 'failed'
export type GuidanceMessageStatus = 'sending' | 'queued' | 'applied' | 'expired' | 'failed'

export interface QueuedWorkbenchMessage {
  id: string
  content: string
  status: QueuedMessageStatus
  createdAt: string
  error?: string
}

export interface GuidanceWorkbenchMessage {
  id: string
  content: string
  status: GuidanceMessageStatus
  createdAt: string
  error?: string
}

export interface WorkbenchState {
  user: User | null
  defaultTeam: Team | null
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  recentTasks: Task[]
  currentProject: ProjectWithTasks | null
  standaloneDeviceId: string | null
  currentTask: Task | null
  input: string
  isBootstrapping: boolean
  isSending: boolean
  error: string | null
}
