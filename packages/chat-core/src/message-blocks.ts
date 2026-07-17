// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type MessageBlockStatus =
  | 'pending'
  | 'generating_arguments'
  | 'streaming'
  | 'invoking'
  | 'done'
  | 'error'
  | 'queued'
  | 'sending'
  | 'failed'
  | 'applied'
  | 'expired'

interface BaseBlock {
  id: string
  parent_tool_use_id?: string
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

export interface SubagentBlock extends BaseBlock {
  type: 'subagent'
  tool_use_id: string
  tool_name?: string
  display_name?: string
  agent_type?: string
  title?: string
  description?: string
  output?: string
  summary?: string
  children?: MessageBlock[]
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
  | SubagentBlock
  | ThinkingBlock
  | GuidanceBlock
  | ErrorBlock
  | VideoBlock
  | ImageBlock
  | PromptOptimizationBlock
  | SubscriptionPreviewBlockType

/** Build the display tree encoded by parent_tool_use_id. */
export function nestMessageBlocks(blocks: MessageBlock[]): MessageBlock[] {
  const blockMap = new Map<string, MessageBlock>()
  const blockOrder: string[] = []
  const parentIds = new Map<string, string>()

  const collectBlock = (block: MessageBlock, nestedParentId?: string) => {
    const existing = blockMap.get(block.id)
    const blockWithoutChildren: MessageBlock =
      block.type === 'subagent' ? { ...block, children: undefined } : { ...block }

    if (!existing) {
      blockOrder.push(block.id)
    }
    blockMap.set(
      block.id,
      existing ? ({ ...existing, ...blockWithoutChildren } as MessageBlock) : blockWithoutChildren
    )

    const parentId = block.parent_tool_use_id || nestedParentId
    if (parentId && parentId !== block.id) {
      parentIds.set(block.id, parentId)
    }

    if (block.type === 'subagent') {
      block.children?.forEach(child => collectBlock(child, block.id))
    }
  }

  blocks.forEach(block => collectBlock(block))

  const childIdsByParent = new Map<string, string[]>()
  parentIds.forEach((parentId, childId) => {
    if (blockMap.get(parentId)?.type !== 'subagent') return
    const childIds = childIdsByParent.get(parentId) || []
    childIds.push(childId)
    childIdsByParent.set(parentId, childIds)
  })

  const buildBlock = (blockId: string, ancestors: Set<string>): MessageBlock => {
    const block = blockMap.get(blockId)!
    if (block.type !== 'subagent' || ancestors.has(blockId)) {
      return block
    }

    const nextAncestors = new Set(ancestors)
    nextAncestors.add(blockId)
    return {
      ...block,
      children: (childIdsByParent.get(blockId) || []).map(childId =>
        buildBlock(childId, nextAncestors)
      ),
    }
  }

  return blockOrder
    .filter(blockId => {
      const parentId = parentIds.get(blockId)
      return !parentId || blockMap.get(parentId)?.type !== 'subagent'
    })
    .map(blockId => buildBlock(blockId, new Set()))
}
