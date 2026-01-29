// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription (订阅) related types.
 * Refactored from Flow types to align with CRD architecture.
 */

// Subscription task type enumeration
export type SubscriptionTaskType = 'execution' | 'collection'

// Subscription visibility enumeration
export type SubscriptionVisibility = 'public' | 'private' | 'market'

// Subscription trigger type enumeration
export type SubscriptionTriggerType = 'cron' | 'interval' | 'one_time' | 'event'

// Event trigger sub-type enumeration
export type SubscriptionEventType = 'webhook' | 'git_push'

// Background execution status enumeration
export type BackgroundExecutionStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'COMPLETED_SILENT'
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
  visibility: SubscriptionVisibility
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
  // Visibility and follow-related fields
  followers_count: number
  is_following: boolean
  owner_username?: string
  // Market rental fields
  is_rental?: boolean
  source_subscription_id?: number
  source_subscription_name?: string
  source_subscription_display_name?: string
  source_owner_username?: string
  rental_count?: number
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
  visibility?: SubscriptionVisibility
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
  visibility?: SubscriptionVisibility
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
  // Permission field - indicates if current user can delete this execution
  can_delete?: boolean
  // Silent execution flag - indicates if this execution completed silently
  is_silent?: boolean
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

// ========== Subscription Follow/Visibility Types ==========

// Follow type enumeration
export type FollowType = 'direct' | 'invited'

// Invitation status enumeration
export type InvitationStatus = 'pending' | 'accepted' | 'rejected'

// Follower response
export interface SubscriptionFollowerResponse {
  user_id: number
  username: string
  follow_type: FollowType
  followed_at: string
}

// Followers list response
export interface SubscriptionFollowersListResponse {
  total: number
  items: SubscriptionFollowerResponse[]
}

// Following subscription response
export interface FollowingSubscriptionResponse {
  subscription: Subscription
  follow_type: FollowType
  followed_at: string
}

// Following subscriptions list response
export interface FollowingSubscriptionsListResponse {
  total: number
  items: FollowingSubscriptionResponse[]
}

// Invite user request
export interface InviteUserRequest {
  user_id?: number
  email?: string
}

// Invite namespace request
export interface InviteNamespaceRequest {
  namespace_id: number
}

// Subscription invitation response
export interface SubscriptionInvitationResponse {
  id: number
  subscription_id: number
  subscription_name: string
  subscription_display_name: string
  invited_by_user_id: number
  invited_by_username: string
  invitation_status: InvitationStatus
  invited_at: string
  owner_username: string
}

// Invitations list response
export interface SubscriptionInvitationsListResponse {
  total: number
  items: SubscriptionInvitationResponse[]
}

// Discover subscription response
export interface DiscoverSubscriptionResponse {
  id: number
  name: string
  display_name: string
  description?: string
  task_type: SubscriptionTaskType
  owner_user_id: number
  owner_username: string
  followers_count: number
  is_following: boolean
  created_at: string
  updated_at: string
}

// Discover subscriptions list response
export interface DiscoverSubscriptionsListResponse {
  total: number
  items: DiscoverSubscriptionResponse[]
}

// ========== Market/Rental Types ==========

// Market subscription detail (hides sensitive information)
export interface MarketSubscriptionDetail {
  id: number
  name: string
  display_name: string
  description?: string
  task_type: SubscriptionTaskType
  trigger_type: SubscriptionTriggerType
  trigger_description: string
  owner_user_id: number
  owner_username: string
  rental_count: number
  is_rented: boolean
  created_at: string
  updated_at: string
}

// Market subscriptions list response
export interface MarketSubscriptionsListResponse {
  total: number
  items: MarketSubscriptionDetail[]
}

// Rent subscription request
export interface RentSubscriptionRequest {
  name: string
  display_name: string
  trigger_type: SubscriptionTriggerType
  trigger_config: Record<string, unknown>
  model_ref?: SubscriptionModelRef
}

// Rental subscription response
export interface RentalSubscriptionResponse {
  id: number
  name: string
  display_name: string
  namespace: string
  source_subscription_id: number
  source_subscription_name: string
  source_subscription_display_name: string
  source_owner_user_id: number
  source_owner_username: string
  trigger_type: SubscriptionTriggerType
  trigger_config: Record<string, unknown>
  model_ref?: SubscriptionModelRef
  enabled: boolean
  last_execution_time?: string
  last_execution_status?: string
  next_execution_time?: string
  execution_count: number
  created_at: string
  updated_at: string
}

// Rental subscriptions list response
export interface RentalSubscriptionsListResponse {
  total: number
  items: RentalSubscriptionResponse[]
}

// Rental count response
export interface RentalCountResponse {
  subscription_id: number
  rental_count: number
}
