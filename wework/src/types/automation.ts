import type { RuntimeTaskCreateRequest } from './api'

export type AutomationSource = 'local' | 'cloud'
export type AutomationConversationMode = 'independent' | 'continue_thread'
export type AutomationNotificationPolicy = 'all_runs' | 'attention_only' | 'never'

export type AutomationSchedule =
  | { type: 'cron'; expression: string }
  | { type: 'interval'; value: number; unit: 'minutes' | 'hours' | 'days' }
  | { type: 'one_time'; executeAt: string }

export type AutomationRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'needs_attention'
  | 'cancelled'

export interface Automation {
  id: string
  version: number
  source: AutomationSource
  name: string
  description: string
  prompt: string
  schedule: AutomationSchedule
  timezone: string
  enabled: boolean
  conversationMode: AutomationConversationMode
  notificationPolicy: AutomationNotificationPolicy
  taskRequest?: RuntimeTaskCreateRequest
  taskPayload?: Record<string, unknown>
  continuationPayload?: Record<string, unknown> | null
  nextRunAt?: string | null
  lastRunAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface AutomationRun {
  id: string
  automationId: string
  source: AutomationSource
  scheduledFor: string
  trigger: 'scheduled' | 'manual' | string
  status: AutomationRunStatus
  taskId?: string | null
  deviceId?: string | null
  workspacePath?: string | null
  error?: string | null
  createdAt: string
  updatedAt: string
}

export interface AutomationMutation {
  id?: string
  version?: number
  source: AutomationSource
  name: string
  description?: string
  prompt: string
  schedule: AutomationSchedule
  timezone: string
  enabled: boolean
  conversationMode: AutomationConversationMode
  notificationPolicy: AutomationNotificationPolicy
  taskRequest: RuntimeTaskCreateRequest
  continuationPayload?: Record<string, unknown> | null
}

export interface AutomationListResponse {
  items: Automation[]
}

export interface AutomationRunListResponse {
  items: AutomationRun[]
}
