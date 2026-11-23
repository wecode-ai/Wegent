import type { Attachment, RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'

export type TodoViewState = 'inbox' | 'backlog' | 'started' | 'review' | 'completed'

export interface TodoDetailItem {
  id: string
  code: string
  title: string
  state: TodoViewState
  runtime: string
  workspace: string
  kind: 'runtime' | 'draft'
  description?: string
  objective?: string
  priority?: string
  priorityValue?: 'none' | 'urgent' | 'high' | 'normal' | 'low'
  assignee?: string
  assigneeType?: 'unassigned' | 'ai' | 'human'
  dueDate?: string
  attachments?: Attachment[]
  createdAt?: string | number | null
  updatedAt?: string | number | null
  address?: RuntimeTaskAddress
  task?: RuntimeTaskSummary
  parentId?: string
  children?: TodoDetailItem[]
  workTypeKey?: string
  workTypeName?: string
  blocker?: string
  nextAction?: string
  collaborators?: Array<{ type: 'human' | 'ai' | 'unassigned'; id?: string; name?: string }>
  confirmer?: string
  workspaceItemId?: string
  waitingFor?: string[]
  events?: Array<{ id: string; summary: string; createdAt: string }>
}
