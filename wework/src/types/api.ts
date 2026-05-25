export interface User {
  id: number
  user_name: string
  email: string
}

export interface Team {
  id: number
  name: string
  displayName?: string | null
  is_active: boolean
  default_for_modes?: string[]
  recommended_mode?: 'chat' | 'code' | 'both'
}

export interface ProjectConfig {
  mode?: 'workspace' | string
  path?: string
  device_id?: string
}

export interface ProjectTask {
  id: number
  task_id: number
  title?: string
  created_at?: string
  updated_at?: string
  task_type?: string
}

export interface ProjectWithTasks {
  id: number
  name: string
  description?: string | null
  color?: string | null
  config?: ProjectConfig | null
  tasks?: ProjectTask[]
}

export interface ProjectListResponse {
  items: ProjectWithTasks[]
}

export interface Task {
  id: number
  title: string
  status: string
  task_type?: 'chat' | 'code' | 'task' | 'knowledge' | 'video' | 'image'
  team_id?: number
  created_at: string
  updated_at?: string
  is_group_chat?: boolean
}

export interface TaskListResponse {
  total: number
  items: Task[]
}

export interface TaskContextData {
  id: number
  context_type: 'attachment' | 'knowledge_base'
  name: string
  status: string
}

export interface Subtask {
  id: number
  role: string
  prompt?: string
  result?: unknown
  status: string
  created_at: string
  updated_at?: string
  contexts?: TaskContextData[]
  sender_user_name?: string
}

export interface TaskDetail extends Task {
  subtasks?: Subtask[]
}

export interface CreateProjectConversationRequest {
  prompt: string
  title?: string
  new_session?: boolean
}

export interface CreateProjectConversationResponse {
  task_id: number
  project_id: number
  task: unknown
}
