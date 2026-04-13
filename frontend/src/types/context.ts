// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Context types that can be added to chat messages
 * 可以添加到聊天消息的上下文类型
 *
 * Future types to be added: 'person' | 'bot' | 'team'
 */
export type ContextType = 'knowledge_base' | 'table' | 'queue_message'

/**
 * Base interface for all context items
 * 所有上下文项的基础接口
 */
export interface BaseContextItem {
  id: number | string
  name: string
  type: ContextType
}

/**
 * Knowledge base context item
 * 知识库上下文项
 */
export interface KnowledgeBaseContext extends BaseContextItem {
  type: 'knowledge_base'
  description?: string
  retriever_name?: string
  retriever_namespace?: string
  document_count?: number
}

/**
 * Table context item (supports DingTalk, Feishu, etc.)
 * 多维表格上下文项（支持钉钉、飞书等）
 */
export interface TableContext extends BaseContextItem {
  type: 'table'
  document_id: number
  source_config?: {
    url?: string
  }
}

/**
 * Queue message context item (for processing inbox messages)
 */
export interface QueueMessageContext extends BaseContextItem {
  type: 'queue_message'
  /** Sender's username */
  senderName: string
  /** Optional note from sender */
  note?: string
  /** Message content preview (truncated) */
  contentPreview: string
  /** Full message content for sending to AI */
  fullContent: string
  /** Number of messages in the snapshot */
  messageCount: number
  /** Source task ID */
  sourceTaskId: number
}

/**
 * Union type for all context items
 * 所有上下文项的联合类型
 *
 * When adding new context types:
 * 1. Add the type to ContextType union above
 * 2. Create a new interface extending BaseContextItem
 * 3. Add the new interface to this union type
 */
export type ContextItem = KnowledgeBaseContext | TableContext | QueueMessageContext
