// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type TaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'CANCELLING'
  | 'DELETE'
  | 'PENDING_CONFIRMATION'

export interface TaskDetail {
  id: number
  status: TaskStatus
  updated_at?: string
}

export interface TaskDetailSubtask {
  id: number
  role?: string
  status?: TaskStatus | string
  prompt?: string
  result?: unknown
  created_at: string
  message_id?: number
  attachments?: unknown[]
  contexts?: unknown[]
  bots?: Array<{ name?: string }>
  error_message?: string
  sender_user_name?: string
  sender_user_id?: number
}

export interface ContextMetricsSnapshot {
  context_window: number
  reserved_output_tokens: number
  available_input_tokens: number
  used_input_tokens: number
  remaining_input_tokens: number
  remaining_percent: number
  display_remaining_tokens: number
  display_remaining_percent: number
  trigger_limit: number
  target_limit: number
  is_over_trigger: boolean
}
