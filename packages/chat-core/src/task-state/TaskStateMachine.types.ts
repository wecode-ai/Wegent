// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskDetail, TaskStatus as ApiTaskStatus } from '../api-types'
import type { ContextMetricsSnapshot } from '../api-types'
import type { MessageBlock } from '../message-blocks'
import type { TaskRuntimePhase } from './taskStatusClassifier'

/**
 * Task state machine status
 */
export type TaskStatus =
  | 'idle' // Not joined WebSocket room
  | 'waiting_socket' // Recovery is pending until WebSocket connects
  | 'joining' // Joining WebSocket room
  | 'syncing' // Syncing messages from backend
  | 'ready' // Ready, no streaming
  | 'streaming' // Has active streaming message
  | 'error' // Error occurred

/**
 * Message status for display
 */
export type MessageStatus = 'pending' | 'streaming' | 'completed' | 'error'

/**
 * Unified message structure
 */
export interface UnifiedMessage {
  id: string
  type: 'user' | 'ai'
  status: MessageStatus
  content: string
  attachment?: unknown
  attachments?: unknown[]
  contexts?: unknown[]
  timestamp: number
  turnId?: number
  messageId?: number
  error?: string
  errorType?: string
  botName?: string
  senderUserName?: string
  senderUserId?: number
  shouldShowSender?: boolean
  subtaskStatus?: string
  reasoningContent?: string
  /** Whether reasoning content is actively streaming (reasoning chunks arriving, no content yet) */
  isReasoningStreaming?: boolean
  result?: {
    value?: string
    thinking?: unknown[]
    workbench?: Record<string, unknown>
    shell_type?: string
    sources?: Array<{
      index: number
      title: string
      kb_id: number
    }>
    reasoning_content?: string
    reasoning_chunk?: string
    blocks?: MessageBlock[]
    context_metrics?: ContextMetricsSnapshot
    /** Video generation config (stored in user message subtask for display) */
    video_config?: {
      model?: string
      resolution?: string
      ratio?: string
      duration?: number
    }
  }
  sources?: Array<{
    index: number
    title: string
    kb_id: number
  }>
}

/**
 * Raw streaming recovery payload from joinTask response.
 *
 * This data is normalized into runtime state and messages during sync; it must
 * not be kept as a second source of streaming state.
 */
export interface StreamingRecoveryPayload {
  subtask_id: number
  offset: number
  cached_content: string
  started_at?: string
  last_activity_at?: string
  /** Blocks from Redis for page refresh recovery (tool blocks and text blocks) */
  blocks?: MessageBlock[]
}

export type TaskRecoveryReason =
  | 'task-selected'
  | 'page-visible'
  | 'websocket-reconnect'
  | 'task-status-event'
  | 'join-ack'
  | 'queued-message-blocked'
  | 'manual-refresh'
  | 'runtime-instability-probe'
  | 'network-online'

export interface TaskRuntimeState {
  taskId: number
  phase: TaskRuntimePhase
  taskStatus?: ApiTaskStatus
  joinedRoom: boolean
  activeStreamSubtaskId?: number
  activeStreamStartedAt?: string
  activeStreamLastActivityAt?: string
  localStreamCursor: number
  localLastChunkAt?: number
  lastVerifiedServerCursor?: number
  lastVerifiedAt?: number
  lastSyncedAt?: number
  lastStatusUpdatedAt?: string
  messagesSyncedUpdatedAt?: string
  lastTerminalStatusUpdatedAt?: string
  hasTerminalStatus?: boolean
  deferredTerminalStatus?: ApiTaskStatus
  deferredTerminalUpdatedAt?: string
  recoveryReason?: TaskRecoveryReason
  recoveryError?: string
  /**
   * Set when recovery confirms the server has no active stream.
   * Prevents stale runtime lifecycle status from keeping the chat UI in a
   * streaming/loading state after cancel or reconnect recovery.
   * Cleared by SEND_ACCEPTED (new send) and terminal lifecycle transitions.
   */
  serverConfirmedNoStream?: boolean
}

export interface TaskRuntimeDerivedState {
  isExecutionActive: boolean
  isTerminal: boolean
  isStreaming: boolean
  shouldJoinRoom: boolean
  canSendMessage: boolean
  canQueueMessage: boolean
  canCancelTask: boolean
  blocksQueuedDispatch: boolean
  serverConfirmedNoStream: boolean
}

export interface TaskRuntimeVerifyResult {
  task_id: number
  task_status: ApiTaskStatus
  status_updated_at?: string | null
  active_stream: {
    subtask_id: number
    cursor: number
    last_activity_at?: string | null
  } | null
}

/**
 * Pending chunk event to be applied after sync completes
 */
export interface PendingChunkEvent {
  turnId: number
  content: string
  offset?: number
  result?: UnifiedMessage['result']
  sources?: UnifiedMessage['sources']
  blockId?: string
}

export interface TaskMachineInternalState {
  taskId: number
  status: TaskStatus
  messages: Map<string, UnifiedMessage>
  error: string | null
  isStopping: boolean
  runtime: TaskRuntimeState
  derived: TaskRuntimeDerivedState
}

export interface TaskStateSnapshot {
  taskId: number
  phase: TaskStatus
  messages: Map<string, UnifiedMessage>
  error: string | null
  isStopping: boolean
  runtime: TaskRuntimeState
  derived: TaskRuntimeDerivedState
}

/**
 * State machine events
 */
export type Event =
  | {
      type: 'RECOVER'
      force?: boolean
      reason?: TaskRecoveryReason
      resumeFromCursor?: number
      activeStreamSubtaskId?: number
      syncAfterMessageId?: number
      syncUpdatedAt?: string
    }
  | {
      type: 'CHAT_START'
      turnId: number
      shellType?: string
      messageId?: number
      botName?: string
    }
  | {
      type: 'CHAT_CHUNK'
      turnId: number
      content: string
      offset?: number
      result?: UnifiedMessage['result']
      sources?: UnifiedMessage['sources']
      blockId?: string
    }
  | {
      type: 'CHAT_DONE'
      turnId: number
      content?: string
      result?: UnifiedMessage['result']
      messageId?: number
      sources?: UnifiedMessage['sources']
      hasError?: boolean
      errorMessage?: string
    }
  | { type: 'CHAT_ERROR'; turnId: number; error: string; messageId?: number; errorType?: string }
  | { type: 'CHAT_CANCELLED'; turnId: number }
  | { type: 'SEND_ACCEPTED'; acceptedAt: string }
  | { type: 'TASK_STATUS_RECEIVED'; taskStatus: ApiTaskStatus; updatedAt?: string }
  | { type: 'TASK_DETAIL_SYNCED'; taskStatus: ApiTaskStatus; updatedAt?: string }
  | { type: 'LEAVE' }

/**
 * Options for sync backend messages
 */
export interface SyncOptions {
  teamName?: string
  isGroupChat?: boolean
  currentUserId?: number
  currentUserName?: string
  forceClean?: boolean
}

/**
 * State change listener
 */
export type StateListener = (state: TaskStateSnapshot) => void

/**
 * Dependencies injected from context
 */
export interface TaskStateMachineDeps {
  pullTaskDetail?: (
    taskId: number
  ) => Promise<Pick<TaskDetail, 'id' | 'status' | 'updated_at'> | null>
  pullRuntime?: (taskId: number) => Promise<TaskRuntimeVerifyResult | null>
  joinTask: (
    taskId: number,
    options?: {
      forceRefresh?: boolean
      afterMessageId?: number
      resumeFromCursor?: number
      activeStreamSubtaskId?: number
    }
  ) => Promise<{
    streaming?: StreamingRecoveryPayload
    /** Subtasks data for immediate message sync (same format as task detail API) */
    subtasks?: Array<Record<string, unknown>>
    error?: string
  }>
  leaveTask?: (taskId: number) => void
  isConnected: () => boolean
  ensureConnected?: () => void
}
