// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription (订阅) related types.
 * Refactored from Flow types to align with CRD architecture.
 */

// Subscription task type enumeration
export type SubscriptionTaskType = 'execution' | 'collection'

// Subscription trigger type enumeration
export type SubscriptionTriggerType = 'cron' | 'interval' | 'one_time' | 'event'

// Event trigger sub-type enumeration
export type SubscriptionEventType = 'webhook' | 'git_push'

// Background execution status enumeration
export type BackgroundExecutionStatus =
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
  event_type: SubscriptionEventType
  git_push?: GitPushEventConfig
}

export type SubscriptionTriggerConfig =
  | CronTriggerConfig
  | IntervalTriggerConfig
  | OneTimeTriggerConfig
  | EventTriggerConfig

// Model reference for Subscription
export interface SubscriptionModelRef {
  name: string
  namespace: string
}

// Subscription configuration
export interface Subscription {
  id: number
  user_id: number
  name: string
  namespace: string
  display_name: string
  description?: string
  task_type: SubscriptionTaskType
  trigger_type: SubscriptionTriggerType
  trigger_config: Record<string, unknown>
  team_id: number
  workspace_id?: number
  // Model reference fields
  model_ref?: SubscriptionModelRef
  force_override_bot_model?: boolean
  prompt_template: string
  retry_count: number
  timeout_seconds: number // Execution timeout (60-3600s, default 600)
  enabled: boolean
  // History preservation settings
  preserve_history?: boolean // Whether to preserve conversation history across executions
  bound_task_id?: number // Task ID bound to this subscription for history preservation
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

// Subscription creation request
export interface SubscriptionCreateRequest {
  name: string
  namespace?: string
  display_name: string
  description?: string
  task_type: SubscriptionTaskType
  trigger_type: SubscriptionTriggerType
  trigger_config: Record<string, unknown>
  team_id: number
  workspace_id?: number
  // Git repository fields (alternative to workspace_id)
  git_repo?: string
  git_repo_id?: number
  git_domain?: string
  branch_name?: string
  // Model reference fields
  model_ref?: SubscriptionModelRef
  force_override_bot_model?: boolean
  prompt_template: string
  retry_count?: number
  timeout_seconds?: number // Execution timeout (60-3600s)
  enabled?: boolean
  // History preservation settings
  preserve_history?: boolean // Whether to preserve conversation history across executions
}

// Subscription update request
export interface SubscriptionUpdateRequest {
  display_name?: string
  description?: string
  task_type?: SubscriptionTaskType
  trigger_type?: SubscriptionTriggerType
  trigger_config?: Record<string, unknown>
  team_id?: number
  workspace_id?: number
  // Git repository fields (alternative to workspace_id)
  git_repo?: string
  git_repo_id?: number
  git_domain?: string
  branch_name?: string
  // Model reference fields
  model_ref?: SubscriptionModelRef
  force_override_bot_model?: boolean
  prompt_template?: string
  retry_count?: number
  timeout_seconds?: number // Execution timeout (60-3600s)
  enabled?: boolean
  // History preservation settings
  preserve_history?: boolean // Whether to preserve conversation history across executions
}

// Subscription list response
export interface SubscriptionListResponse {
  total: number
  items: Subscription[]
}

// Background execution record
export interface BackgroundExecution {
  id: number
  user_id: number
  subscription_id: number
  task_id?: number
  trigger_type: string
  trigger_reason?: string
  prompt: string
  status: BackgroundExecutionStatus
  result_summary?: string
  error_message?: string
  retry_attempt: number
  started_at?: string
  completed_at?: string
  created_at: string
  updated_at: string
  // Enriched fields from subscription
  subscription_name?: string
  subscription_display_name?: string
  team_name?: string
  task_type?: string
}

// Background execution list response
export interface BackgroundExecutionListResponse {
  total: number
  items: BackgroundExecution[]
}

// Timeline filter options
export interface SubscriptionTimelineFilter {
  time_range?: 'today' | '7d' | '30d' | 'custom'
  start_date?: string
  end_date?: string
  status?: BackgroundExecutionStatus[]
  subscription_ids?: number[]
  team_ids?: number[]
  task_types?: SubscriptionTaskType[]
}
