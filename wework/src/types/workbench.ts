import type { Attachment, DeviceInfo, ProjectWithTasks, Task, Team, User } from './api'

export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'pending' | 'streaming' | 'done' | 'failed'

export type ToolBlockStatus = 'generating_arguments' | 'pending' | 'streaming' | 'done' | 'error'

export interface BaseProcessingBlock {
  id: string
  subtaskId: number
  status: ToolBlockStatus
  createdAt: number
}

export interface ToolBlock extends BaseProcessingBlock {
  type: 'tool'
  toolName: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
}

export interface ThinkingBlock extends BaseProcessingBlock {
  type: 'thinking'
  content: string
}

export type ProcessingBlock = ToolBlock | ThinkingBlock

export interface WorkbenchMessage {
  id: string
  taskId?: number
  subtaskId?: number
  shellType?: string
  role: MessageRole
  content: string
  status: MessageStatus
  error?: string
  attachments?: Attachment[]
  blocks?: ProcessingBlock[]
  createdAt: string
}

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
