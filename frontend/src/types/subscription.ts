// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription types for Smart Feed feature
 */

export type TriggerType = 'cron' | 'webhook'

export type SubscriptionRunStatus = 'pending' | 'running' | 'success' | 'failed'

export interface CronConfig {
  expression: string
  timezone?: string
}

export interface WebhookConfig {
  secret?: string
}

export interface TriggerConfig {
  type: TriggerType
  cron?: CronConfig
  webhook?: WebhookConfig
}

export interface AlertPolicy {
  enabled: boolean
  prompt?: string
  keywords?: string[]
}

export interface RetentionConfig {
  days: number
}

export interface TeamRef {
  name: string
  namespace?: string
}

export interface Subscription {
  id: number
  user_id: number
  namespace: string
  name: string
  description?: string
  team_id: number
  team_name: string
  team_namespace: string
  trigger_type: string
  cron_expression?: string
  cron_timezone?: string
  webhook_secret?: string
  alert_enabled: boolean
  alert_prompt?: string
  alert_keywords?: string[]
  retention_days: number
  enabled: boolean
  last_run_time?: string
  last_run_status?: string
  unread_count: number
  total_item_count: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface SubscriptionCreate {
  name: string
  description?: string
  namespace?: string
  team_id?: number
  team_name?: string
  team_namespace?: string
  trigger: TriggerConfig
  alert_policy?: AlertPolicy
  retention?: RetentionConfig
  enabled?: boolean
}

export interface SubscriptionUpdate {
  name?: string
  description?: string
  team_id?: number
  team_name?: string
  team_namespace?: string
  trigger?: TriggerConfig
  alert_policy?: AlertPolicy
  retention?: RetentionConfig
  enabled?: boolean
}

export interface SubscriptionItem {
  id: number
  subscription_id: number
  title: string
  content?: string
  summary?: string
  source_url?: string
  metadata?: Record<string, unknown>
  should_alert: boolean
  alert_reason?: string
  is_read: boolean
  task_id?: number
  run_id?: number
  created_at: string
}

export interface SubscriptionRun {
  id: number
  subscription_id: number
  task_id?: number
  status: SubscriptionRunStatus
  items_collected: number
  items_alerted: number
  started_at?: string
  finished_at?: string
  error_message?: string
}

export interface UnreadCountResponse {
  total_unread: number
  subscriptions: Array<{
    id: number
    name: string
    unread_count: number
  }>
}

export interface SubscriptionListResponse {
  total: number
  items: Subscription[]
}

export interface SubscriptionItemListResponse {
  total: number
  items: SubscriptionItem[]
}

export interface SubscriptionRunListResponse {
  total: number
  items: SubscriptionRun[]
}
