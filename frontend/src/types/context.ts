// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Context types that can be added to chat messages
 * 可以添加到聊天消息的上下文类型
 *
 * Future types to be added: 'person' | 'bot' | 'team'
 */
export type ContextType =
  | 'knowledge_base'
  | 'table'
  | 'queue_message'
  | 'dingtalk_doc'
  | 'external_knowledge'

/**
 * Canonical external knowledge reference shape.
 * Provider-neutral; reused verbatim across the entire chain (send-time
 * context, CHAT_SEND payload, task-level bindings, Bot defaults).
 * `mode`/`scope` must never be dropped. Mirrors the backend ExternalKnowledgeRef
 * (backend/app/services/rag/sources/models.py).
 */
export interface ExternalKnowledgeRef {
  provider: string
  mode: string
  id?: string
  name?: string
  scope?: string
  target_type?: 'knowledge_base' | 'folder' | 'document'
  workspace_id?: string
  node_id?: string
  document_id?: string
  parent_id?: string
  target_name?: string
  boundBy?: string
  boundAt?: string
}

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
  document_ids?: number[]
  document_names?: string[]
  folder_ids?: number[]
  folder_names?: string[]
  include_subfolders?: boolean
  scope_restricted?: boolean
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

/** Inbox attachment metadata for display as badge in chat input */
export interface InboxAttachment {
  /** SubtaskContext ID (used as attachment_id when sending to AI) */
  id: number
  /** File name for display */
  name: string
  /** File extension (e.g. 'pdf', 'md') */
  file_extension?: string
  /** File size in bytes */
  file_size?: number
  /** MIME type */
  mime_type?: string
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
  /** IDs of subtask_contexts records pre-written from uploaded files.
   * These are passed as attachment_ids when sending to AI so the LLM
   * can access the file content via context injection. */
  attachmentContextIds?: number[]
  /** Attachment metadata for displaying as badge in chat input and message bubble.
   * Built from snapshot.attachments when processing inbox messages. */
  inboxAttachments?: InboxAttachment[]
}
/**
 * DingTalk document context item
 * References a synced DingTalk document node by title and URL.
 */
export interface DingTalkDocContext extends BaseContextItem {
  type: 'dingtalk_doc'
  /** DingTalk document URL (e.g. https://alidocs.dingtalk.com/i/nodes/xxx) */
  doc_url: string
  /** Node type: folder, doc, or file */
  node_type: 'folder' | 'doc' | 'file'
  /** DingTalk node ID */
  dingtalk_node_id: string
  /** DingTalk node source to disambiguate docs and wikispace selections */
  source: 'docs' | 'wikispace'
}

/**
 * External knowledge context item selected in the composer before sending.
 * On send, Backend materializes this ref into task-level externalKnowledgeRefs;
 * clearing composer selections does not unbind task-level refs. Embeds the full canonical ref;
 * the context `id` is namespaced
 * (external:{provider}:{mode}:{id ?? 'all'}) to avoid collision with internal
 * KB/table numeric ids. The send-assembly split reads `ref` verbatim.
 */
export interface ExternalKnowledgeContext extends BaseContextItem {
  type: 'external_knowledge'
  id: string
  ref: ExternalKnowledgeRef
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
export type ContextItem =
  | KnowledgeBaseContext
  | TableContext
  | QueueMessageContext
  | DingTalkDocContext
  | ExternalKnowledgeContext
