import type { DeviceInfo, ProjectWithTasks, Task, Team, User } from './api'

export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'pending' | 'streaming' | 'done' | 'failed'

export type ToolBlockStatus = 'generating_arguments' | 'pending' | 'streaming' | 'done' | 'error'

export interface ToolBlock {
  id: string
  subtaskId: number
  toolName: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
  status: ToolBlockStatus
  createdAt: number
}

export interface WorkbenchMessage {
  id: string
  taskId?: number
  subtaskId?: number
  role: MessageRole
  content: string
  status: MessageStatus
  error?: string
  blocks?: ToolBlock[]
  createdAt: string
}

export interface WorkbenchState {
  user: User | null
  defaultTeam: Team | null
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  recentTasks: Task[]
  currentProject: ProjectWithTasks | null
  currentTask: Task | null
  input: string
  isBootstrapping: boolean
  isSending: boolean
  error: string | null
}
