// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * AI Flow (智能流) related types.
 */

// Flow task type enumeration
export type FlowTaskType = 'execution' | 'collection'

// Flow trigger type enumeration
export type FlowTriggerType = 'cron' | 'interval' | 'one_time' | 'event'

// Event trigger sub-type enumeration
export type FlowEventType = 'webhook' | 'git_push'

// Flow execution status enumeration
export type FlowExecutionStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'RETRYING'
  | 'CANCELLED'

// Trigger configuration types
export interface CronTriggerConfig {
  expression: string
  timezone?: string
}

export interface IntervalTriggerConfig {
  value: number
  unit: 'minutes' | 'hours' | 'days'
}

export interface OneTimeTriggerConfig {
  execute_at: string // ISO datetime string
}

export interface GitPushEventConfig {
  repository: string
  branch?: string
}

export interface EventTriggerConfig {
  event_type: FlowEventType
  git_push?: GitPushEventConfig
}

export type FlowTriggerConfig =
  | CronTriggerConfig
  | IntervalTriggerConfig
  | OneTimeTriggerConfig
  | EventTriggerConfig

// Flow configuration
export interface Flow {
  id: number
  user_id: number
  name: string
  namespace: string
  display_name: string
  description?: string
  task_type: FlowTaskType
  trigger_type: FlowTriggerType
  trigger_config: Record<string, unknown>
  team_id: number
  workspace_id?: number
  prompt_template: string
  retry_count: number
  timeout_seconds: number // Execution timeout (60-3600s, default 600)
  enabled: boolean
  webhook_url?: string
  webhook_secret?: string // HMAC signing secret for webhook verification
  last_execution_time?: string
  last_execution_status?: string
  next_execution_time?: string
  execution_count: number
  success_count: number
  failure_count: number
  created_at: string
  updated_at: string
}

// Flow creation request
export interface FlowCreateRequest {
  name: string
  namespace?: string
  display_name: string
  description?: string
  task_type: FlowTaskType
  trigger_type: FlowTriggerType
  trigger_config: Record<string, unknown>
  team_id: number
  workspace_id?: number
  prompt_template: string
  retry_count?: number
  timeout_seconds?: number // Execution timeout (60-3600s)
  enabled?: boolean
}

// Flow update request
export interface FlowUpdateRequest {
  display_name?: string
  description?: string
  task_type?: FlowTaskType
  trigger_type?: FlowTriggerType
  trigger_config?: Record<string, unknown>
  team_id?: number
  workspace_id?: number
  prompt_template?: string
  retry_count?: number
  timeout_seconds?: number // Execution timeout (60-3600s)
  enabled?: boolean
}

// Flow list response
export interface FlowListResponse {
  total: number
  items: Flow[]
}

// Flow execution record
export interface FlowExecution {
  id: number
  user_id: number
  flow_id: number
  task_id?: number
  trigger_type: string
  trigger_reason?: string
  prompt: string
  status: FlowExecutionStatus
  result_summary?: string
  error_message?: string
  retry_attempt: number
  started_at?: string
  completed_at?: string
  created_at: string
  updated_at: string
  // Enriched fields from flow
  flow_name?: string
  flow_display_name?: string
  team_name?: string
  task_type?: string
}

// Flow execution list response
export interface FlowExecutionListResponse {
  total: number
  items: FlowExecution[]
}

// Timeline filter options
export interface FlowTimelineFilter {
  time_range?: 'today' | '7d' | '30d' | 'custom'
  start_date?: string
  end_date?: string
  status?: FlowExecutionStatus[]
  flow_ids?: number[]
  team_ids?: number[]
  task_types?: FlowTaskType[]
}
