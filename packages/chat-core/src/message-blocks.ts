// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type MessageBlockStatus =
  | 'pending'
  | 'generating_arguments'
  | 'streaming'
  | 'done'
  | 'error'
  | 'queued'
  | 'sending'
  | 'failed'
  | 'applied'
  | 'expired'

interface BaseBlock {
  id: string
  status?: MessageBlockStatus
  timestamp?: number
}

export interface TextBlock extends BaseBlock {
  type: 'text'
  content: string
}

export interface ToolBlock extends BaseBlock {
  type: 'tool'
  tool_use_id: string
  tool_name: string
  display_name?: string
  tool_input?: Record<string, unknown>
  tool_output?: unknown
  render_payload?: unknown
  argument_status?: 'streaming' | 'done'
  metadata?: Record<string, unknown>
}

export interface ThinkingBlock extends BaseBlock {
  type: 'thinking'
  content: string
}

export interface GuidanceBlock extends BaseBlock {
  type: 'guidance'
  guidance_id: string
  content: string
  status: MessageBlockStatus
  loop_index?: number
  applied_at?: string
}

export interface ErrorBlock extends BaseBlock {
  type: 'error'
  content: string
}

export interface VideoBlock extends BaseBlock {
  type: 'video'
  video_url: string
  video_thumbnail?: string | null
  video_duration?: number | null
  video_attachment_id?: number | null
  video_progress?: number
  is_placeholder?: boolean
  content?: string
}

export interface ImageBlock extends BaseBlock {
  type: 'image'
  image_urls: string[]
  image_attachment_ids?: number[]
  image_count: number
  is_placeholder?: boolean
  content?: string
}

export interface PromptChangeItem {
  type: 'ghost' | 'member'
  id: number
  name: string
  field: string
  original: string
  suggested: string
  index?: number
}

export interface PromptOptimizationApplyAction {
  endpoint: string
  method: string
  payload: {
    team_id: number
    changes: Array<{
      type: 'ghost' | 'member'
      id?: number
      team_id?: number
      index?: number
      field?: string
      value: string
    }>
  }
}

export interface PromptOptimizationBlock extends BaseBlock {
  type: 'prompt_optimization'
  changes: PromptChangeItem[]
  apply_action: PromptOptimizationApplyAction
}

export interface SubscriptionPreviewConfig {
  display_name: string
  description?: string
  trigger_type: 'cron' | 'interval' | 'one_time'
  trigger_display: string
  prompt_preview: string
  preserve_history: boolean
  history_message_count: number
  retry_count: number
  timeout_seconds: number
  expires_at?: string
}

export interface SubscriptionPreviewBlockType extends BaseBlock {
  type: 'subscription_preview'
  preview_id: string
  execution_id: string
  task_id: number
  subtask_id: number
  config: SubscriptionPreviewConfig
  created_at: string
}

export type MessageBlock =
  | TextBlock
  | ToolBlock
  | ThinkingBlock
  | GuidanceBlock
  | ErrorBlock
  | VideoBlock
  | ImageBlock
  | PromptOptimizationBlock
  | SubscriptionPreviewBlockType
