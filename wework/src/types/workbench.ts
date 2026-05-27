import type { ProjectWithTasks, Task, Team, User } from './api'

export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'pending' | 'streaming' | 'done' | 'failed'

export interface WorkbenchMessage {
  id: string
  taskId?: number
  subtaskId?: number
  role: MessageRole
  content: string
  status: MessageStatus
  error?: string
  createdAt: string
}

export interface WorkbenchState {
  user: User | null
  defaultTeam: Team | null
  projects: ProjectWithTasks[]
  recentTasks: Task[]
  currentProject: ProjectWithTasks | null
  currentTask: Task | null
  input: string
  isBootstrapping: boolean
  isSending: boolean
  error: string | null
}
