// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Task State Machine
 *
 * A lightweight state machine for managing task message state.
 * Provides unified message recovery, streaming state management,
 * and WebSocket event handling.
 *
 * State Diagram:
 * ```
 * idle → joining → syncing → ready ⟷ streaming
 *                     ↓           ↓
 *                   error ←───────┘
 * ```
 *
 * Key Features:
 * - State transition table driven (invalid transitions are ignored)
 * - Reentrant: RECOVER events during joining/syncing are queued
 * - Debouncing: RECOVER within 1s is skipped (unless force=true)
 * - Idempotent: Multiple calls produce consistent results
 */

import type { TaskDetailSubtask, Attachment } from '@/types/api'
import type { MessageBlock } from '../components/message/thinking/types'

// ============================================================
// Type Definitions
// ============================================================

/**
 * State machine status enum
 */
export type TaskStateStatus =
  | 'idle' // Not joined to WebSocket room
  | 'joining' // Joining room in progress
  | 'syncing' // Syncing messages in progress
  | 'ready' // Ready, no streaming
  | 'streaming' // Streaming message in progress
  | 'error' // Error state

/**
 * Message type enum
 */
export type MessageType = 'user' | 'ai'

/**
 * Message status enum
 */
export type MessageStatus = 'pending' | 'streaming' | 'completed' | 'error'

/**
 * Unified message structure
 */
export interface UnifiedMessage {
  id: string
  type: MessageType
  status: MessageStatus
  content: string
  timestamp: number
  subtaskId?: number
  messageId?: number
  error?: string
  attachment?: unknown
  attachments?: Attachment[]
  contexts?: unknown[]
  botName?: string
  senderUserName?: string
  senderUserId?: number
  shouldShowSender?: boolean
  subtaskStatus?: string
  reasoningContent?: string
  result?: {
    value?: string
    thinking?: unknown[]
    workbench?: Record<string, unknown>
    shell_type?: string
    sources?: Array<{ index: number; title: string; kb_id: number }>
    reasoning_content?: string
    blocks?: MessageBlock[]
  }
  sources?: Array<{ index: number; title: string; kb_id: number }>
}

/**
 * Streaming info from joinTask response
 */
export interface StreamingInfo {
  subtask_id: number
  offset: number
  cached_content: string
}

/**
 * Task state data structure
 */
export interface TaskStateData {
  taskId: number
  status: TaskStateStatus
  messages: Map<string, UnifiedMessage>
  streamingSubtaskId: number | null
  streamingInfo: StreamingInfo | null
  error: string | null
}

/**
 * Recover options
 */
export interface RecoverOptions {
  subtasks?: TaskDetailSubtask[]
  force?: boolean
  teamName?: string
  isGroupChat?: boolean
  currentUserId?: number
  currentUserName?: string
}

/**
 * Listener callback type
 */
export type TaskStateListener = (state: TaskStateData) => void

/**
 * Socket context interface (injected dependency)
 */
export interface SocketContextInterface {
  joinTask: (
    taskId: number,
    forceRefresh?: boolean
  ) => Promise<{
    streaming?: StreamingInfo
    error?: string
  }>
  leaveTask: (taskId: number) => void
  isConnected: boolean
}

// ============================================================
// State Transition Table
// ============================================================

/**
 * State transition table
 * Maps current state + event → next state
 */
const TRANSITIONS: Record<TaskStateStatus, Partial<Record<string, TaskStateStatus>>> = {
  idle: {
    RECOVER: 'joining',
  },
  joining: {
    JOIN_SUCCESS: 'syncing',
    JOIN_FAILURE: 'idle',
    // RECOVER is queued, not a transition
  },
  syncing: {
    SYNC_DONE: 'ready',
    SYNC_DONE_STREAMING: 'streaming',
    SYNC_ERROR: 'error',
    // RECOVER is queued, not a transition
  },
  ready: {
    RECOVER: 'syncing',
    CHAT_START: 'streaming',
    LEAVE: 'idle',
  },
  streaming: {
    CHAT_DONE: 'ready',
    CHAT_ERROR: 'error',
    RECOVER: 'syncing',
    LEAVE: 'idle',
  },
  error: {
    RECOVER: 'syncing',
    LEAVE: 'idle',
  },
}

/**
 * States that queue RECOVER events instead of processing immediately
 */
const QUEUE_RECOVER_STATES: TaskStateStatus[] = ['joining', 'syncing']

/**
 * States that check and execute queued RECOVER on entry
 */
const CHECK_PENDING_STATES: TaskStateStatus[] = ['ready', 'streaming', 'error']

// ============================================================
// Helper Functions
// ============================================================

/**
 * Generate unique message ID
 */
export function generateMessageId(type: MessageType, identifier: number | string): string {
  if (type === 'user') {
    return `user-${identifier}`
  }
  return `ai-${identifier}`
}

/**
 * Build messages from subtasks with content priority
 *
 * Content Priority (for RUNNING AI messages):
 * 1. Redis cached_content (newest, updated every 1s)
 * 2. Existing messages content
 * 3. Backend DB subtask.result.value (oldest, updated every 5s)
 *
 * Choose the longest content as current.
 */
function buildMessages(
  subtasks: TaskDetailSubtask[],
  existingMessages: Map<string, UnifiedMessage>,
  streamingInfo: StreamingInfo | null,
  options: RecoverOptions
): Map<string, UnifiedMessage> {
  const messages = new Map<string, UnifiedMessage>()
  const { teamName, isGroupChat, currentUserId, currentUserName } = options

  for (const subtask of subtasks) {
    const isUserMessage = subtask.role === 'USER' || subtask.role?.toUpperCase() === 'USER'
    const messageId = isUserMessage
      ? generateMessageId('user', `backend-${subtask.id}`)
      : generateMessageId('ai', subtask.id)

    // Skip PENDING messages (Pipeline mode pre-created)
    if (subtask.status === 'PENDING') {
      continue
    }

    const existing = existingMessages.get(messageId)

    // Determine content based on priority
    let content: string
    let status: MessageStatus

    if (subtask.status === 'RUNNING') {
      // For RUNNING messages, use content priority
      const redisContent =
        streamingInfo?.subtask_id === subtask.id ? streamingInfo.cached_content : null
      const existingContent = existing?.content || ''
      const backendContent = typeof subtask.result?.value === 'string' ? subtask.result.value : ''

      // Choose the longest content (most up-to-date)
      const contents = [redisContent, existingContent, backendContent].filter(
        (c): c is string => c !== null && c !== undefined
      )
      content = contents.reduce((a, b) => (a.length >= b.length ? a : b), '')
      status = 'streaming'
    } else if (subtask.status === 'COMPLETED') {
      content = typeof subtask.result?.value === 'string' ? subtask.result.value : ''
      status = 'completed'
    } else {
      // ERROR, CANCELLED, etc.
      content = typeof subtask.result?.value === 'string' ? subtask.result.value : ''
      status = 'error'
    }

    // Build message
    const message: UnifiedMessage = {
      id: messageId,
      type: isUserMessage ? 'user' : 'ai',
      status,
      content,
      timestamp: new Date(subtask.created_at).getTime(),
      subtaskId: subtask.id,
      messageId: subtask.message_id,
      attachments: subtask.attachments,
      contexts: subtask.contexts,
      subtaskStatus: subtask.status,
      result: subtask.result as UnifiedMessage['result'],
    }

    // Add AI message specific fields
    if (!isUserMessage) {
      message.botName = subtask.bots?.[0]?.name || teamName
      message.sources = subtask.result?.sources as UnifiedMessage['sources']
      message.reasoningContent = subtask.result?.reasoning_content as string | undefined
    }

    // Add group chat specific fields
    if (isGroupChat && isUserMessage) {
      message.senderUserName = subtask.sender_user_name || currentUserName
      message.senderUserId = subtask.sender_user_id || currentUserId
      message.shouldShowSender = true
    }

    // Handle error messages
    if (subtask.error_message) {
      message.error = subtask.error_message
    }

    messages.set(messageId, message)
  }

  // Preserve pending user messages that are not in subtasks yet
  for (const [id, msg] of existingMessages) {
    if (msg.type === 'user' && msg.status === 'pending' && !messages.has(id)) {
      messages.set(id, msg)
    }
  }

  return messages
}

// ============================================================
// TaskStateMachine Class
// ============================================================

/**
 * Task State Machine
 *
 * Manages state for a single task with state machine pattern.
 * Provides reentrant, debounced message recovery.
 */
export class TaskStateMachine {
  readonly taskId: number

  private _status: TaskStateStatus = 'idle'
  private _messages: Map<string, UnifiedMessage> = new Map()
  private _streamingSubtaskId: number | null = null
  private _streamingInfo: StreamingInfo | null = null
  private _error: string | null = null

  // Reentry control
  private _pendingRecover: RecoverOptions | null = null
  private _lastRecoveryTime: number = 0
  private _isJoined: boolean = false

  // Listeners
  private _listeners: Set<TaskStateListener> = new Set()

  // Injected dependencies
  private _socketContext: SocketContextInterface | null = null

  // Configuration
  private static RECOVERY_DEBOUNCE_MS = 1000

  constructor(taskId: number) {
    this.taskId = taskId
  }

  // ============================================================
  // Getters
  // ============================================================

  get status(): TaskStateStatus {
    return this._status
  }

  get messages(): Map<string, UnifiedMessage> {
    return this._messages
  }

  get streamingSubtaskId(): number | null {
    return this._streamingSubtaskId
  }

  get error(): string | null {
    return this._error
  }

  get isStreaming(): boolean {
    return this._status === 'streaming'
  }

  get isJoined(): boolean {
    return this._isJoined
  }

  /**
   * Get current state snapshot
   */
  get state(): TaskStateData {
    return {
      taskId: this.taskId,
      status: this._status,
      messages: this._messages,
      streamingSubtaskId: this._streamingSubtaskId,
      streamingInfo: this._streamingInfo,
      error: this._error,
    }
  }

  // ============================================================
  // Dependency Injection
  // ============================================================

  /**
   * Set socket context for WebSocket operations
   */
  setSocketContext(context: SocketContextInterface): void {
    this._socketContext = context
  }

  // ============================================================
  // State Transitions
  // ============================================================

  /**
   * Send an event to trigger state transition
   * Returns true if transition occurred
   */
  private _transition(event: string): boolean {
    const nextStatus = TRANSITIONS[this._status]?.[event]

    // Handle RECOVER queuing in joining/syncing states
    if (event === 'RECOVER' && QUEUE_RECOVER_STATES.includes(this._status)) {
      console.log(`[TaskStateMachine:${this.taskId}] Queuing RECOVER (current: ${this._status})`)
      // _pendingRecover is set by the caller
      return false
    }

    if (!nextStatus) {
      console.log(
        `[TaskStateMachine:${this.taskId}] Invalid transition: ${this._status} + ${event}`
      )
      return false
    }

    const prevStatus = this._status
    this._status = nextStatus
    console.log(`[TaskStateMachine:${this.taskId}] ${prevStatus} → ${nextStatus} (${event})`)

    // Check for pending RECOVER after entering check states
    if (CHECK_PENDING_STATES.includes(nextStatus) && this._pendingRecover) {
      const options = this._pendingRecover
      this._pendingRecover = null
      // Schedule async recovery
      setTimeout(() => this.recover(options), 0)
    }

    this._notify()
    return true
  }

  // ============================================================
  // Public Methods
  // ============================================================

  /**
   * Recover messages - main entry point for message synchronization
   *
   * Features:
   * - Reentrant: Queues RECOVER if in joining/syncing state
   * - Debounced: Skips recovery within 1s (unless force=true)
   * - Idempotent: Produces consistent results
   */
  async recover(options: RecoverOptions = {}): Promise<void> {
    const now = Date.now()

    // Debouncing: skip recovery within threshold (unless force)
    if (!options.force && now - this._lastRecoveryTime < TaskStateMachine.RECOVERY_DEBOUNCE_MS) {
      console.log(`[TaskStateMachine:${this.taskId}] Skipped recovery (debounce)`)
      return
    }

    // Queue RECOVER if in joining/syncing state
    if (QUEUE_RECOVER_STATES.includes(this._status)) {
      console.log(`[TaskStateMachine:${this.taskId}] Queuing RECOVER (current: ${this._status})`)
      this._pendingRecover = options
      return
    }

    // Transition to joining or syncing
    if (this._status === 'idle') {
      this._transition('RECOVER')
      await this._doJoin(options)
    } else if (['ready', 'streaming', 'error'].includes(this._status)) {
      this._transition('RECOVER')
      await this._doSync(options)
    }

    this._lastRecoveryTime = Date.now()
  }

  /**
   * Handle chat:start event
   */
  handleChatStart(subtaskId: number, botName?: string, shellType?: string): void {
    console.log(`[TaskStateMachine:${this.taskId}] handleChatStart: subtaskId=${subtaskId}`)

    this._streamingSubtaskId = subtaskId

    // Create AI message placeholder
    const messageId = generateMessageId('ai', subtaskId)
    const existingMessage = this._messages.get(messageId)

    this._messages.set(messageId, {
      id: messageId,
      type: 'ai',
      status: 'streaming',
      content: existingMessage?.content || '',
      timestamp: existingMessage?.timestamp || Date.now(),
      subtaskId,
      botName,
      result: {
        ...existingMessage?.result,
        shell_type: shellType || existingMessage?.result?.shell_type,
      },
    })

    // Transition to streaming if not already
    if (this._status !== 'streaming') {
      this._transition('CHAT_START')
    } else {
      this._notify()
    }
  }

  /**
   * Handle chat:chunk event
   */
  handleChatChunk(subtaskId: number, content: string, result?: UnifiedMessage['result']): void {
    const messageId = generateMessageId('ai', subtaskId)
    const existing = this._messages.get(messageId)

    if (!existing) {
      // Create message if not exists (edge case: chunk arrives before start)
      this._messages.set(messageId, {
        id: messageId,
        type: 'ai',
        status: 'streaming',
        content,
        timestamp: Date.now(),
        subtaskId,
        result,
      })
    } else {
      // Append content
      this._messages.set(messageId, {
        ...existing,
        content: existing.content + content,
        result: result ? { ...existing.result, ...result } : existing.result,
      })
    }

    // Transition to streaming if needed
    if (this._status === 'ready') {
      this._transition('CHAT_START')
    } else {
      this._notify()
    }
  }

  /**
   * Handle chat:done event
   */
  handleChatDone(
    subtaskId: number,
    finalResult?: UnifiedMessage['result'],
    messageId?: number
  ): void {
    console.log(`[TaskStateMachine:${this.taskId}] handleChatDone: subtaskId=${subtaskId}`)

    const msgId = generateMessageId('ai', subtaskId)
    const existing = this._messages.get(msgId)

    if (existing) {
      this._messages.set(msgId, {
        ...existing,
        status: 'completed',
        content: finalResult?.value || existing.content,
        result: finalResult || existing.result,
        messageId: messageId ?? existing.messageId,
        sources: finalResult?.sources || existing.sources,
        reasoningContent: finalResult?.reasoning_content || existing.reasoningContent,
      })
    }

    this._streamingSubtaskId = null
    this._streamingInfo = null
    this._transition('CHAT_DONE')
  }

  /**
   * Handle chat:error event
   */
  handleChatError(subtaskId: number, error: string): void {
    console.log(
      `[TaskStateMachine:${this.taskId}] handleChatError: subtaskId=${subtaskId}, error=${error}`
    )

    const messageId = generateMessageId('ai', subtaskId)
    const existing = this._messages.get(messageId)

    if (existing) {
      this._messages.set(messageId, {
        ...existing,
        status: 'error',
        error,
      })
    } else {
      // Create error message if not exists
      this._messages.set(messageId, {
        id: messageId,
        type: 'ai',
        status: 'error',
        content: '',
        timestamp: Date.now(),
        subtaskId,
        error,
      })
    }

    this._error = error
    this._streamingSubtaskId = null
    this._streamingInfo = null
    this._transition('CHAT_ERROR')
  }

  /**
   * Handle chat:cancelled event
   */
  handleChatCancelled(subtaskId: number, partialContent?: string): void {
    console.log(`[TaskStateMachine:${this.taskId}] handleChatCancelled: subtaskId=${subtaskId}`)

    const messageId = generateMessageId('ai', subtaskId)
    const existing = this._messages.get(messageId)

    if (existing) {
      this._messages.set(messageId, {
        ...existing,
        status: 'completed',
        content: partialContent || existing.content,
      })
    }

    this._streamingSubtaskId = null
    this._streamingInfo = null
    this._transition('CHAT_DONE')
  }

  /**
   * Handle chat:message event (group chat, other users' messages)
   */
  handleChatMessage(
    subtaskId: number,
    content: string,
    messageId: number,
    senderUserName?: string,
    senderUserId?: number,
    contexts?: unknown[]
  ): void {
    const msgId = `user-backend-${subtaskId}`

    this._messages.set(msgId, {
      id: msgId,
      type: 'user',
      status: 'completed',
      content,
      timestamp: Date.now(),
      subtaskId,
      messageId,
      senderUserName,
      senderUserId,
      shouldShowSender: true,
      contexts,
    })

    this._notify()
  }

  /**
   * Add pending user message (optimistic update)
   */
  addPendingUserMessage(
    localId: string,
    content: string,
    options?: {
      attachment?: unknown
      attachments?: unknown[]
      contexts?: unknown[]
      senderUserName?: string
      senderUserId?: number
      isGroupChat?: boolean
    }
  ): void {
    this._messages.set(localId, {
      id: localId,
      type: 'user',
      status: 'pending',
      content,
      timestamp: Date.now(),
      attachment: options?.attachment,
      attachments: options?.attachments as Attachment[],
      contexts: options?.contexts,
      senderUserName: options?.senderUserName,
      senderUserId: options?.senderUserId,
      shouldShowSender: options?.isGroupChat,
    })

    this._notify()
  }

  /**
   * Confirm pending user message (after backend ACK)
   */
  confirmUserMessage(localId: string, subtaskId: number, messageId: number): void {
    const existing = this._messages.get(localId)
    if (existing) {
      this._messages.set(localId, {
        ...existing,
        status: 'completed',
        subtaskId,
        messageId,
      })
      this._notify()
    }
  }

  /**
   * Mark user message as error
   */
  markUserMessageError(localId: string, error: string): void {
    const existing = this._messages.get(localId)
    if (existing) {
      this._messages.set(localId, {
        ...existing,
        status: 'error',
        error,
      })
      this._notify()
    }
  }

  /**
   * Leave task room
   */
  leave(): void {
    if (this._socketContext && this._isJoined) {
      this._socketContext.leaveTask(this.taskId)
    }

    this._isJoined = false
    this._streamingSubtaskId = null
    this._streamingInfo = null
    this._pendingRecover = null
    this._transition('LEAVE')
  }

  /**
   * Reset state completely
   */
  reset(): void {
    this._status = 'idle'
    this._messages = new Map()
    this._streamingSubtaskId = null
    this._streamingInfo = null
    this._error = null
    this._pendingRecover = null
    this._isJoined = false
    this._notify()
  }

  // ============================================================
  // Subscription
  // ============================================================

  /**
   * Subscribe to state changes
   */
  subscribe(listener: TaskStateListener): () => void {
    this._listeners.add(listener)
    return () => {
      this._listeners.delete(listener)
    }
  }

  // ============================================================
  // Private Methods
  // ============================================================

  /**
   * Notify all listeners of state change
   */
  private _notify(): void {
    const state = this.state
    this._listeners.forEach(listener => {
      try {
        listener(state)
      } catch (err) {
        console.error(`[TaskStateMachine:${this.taskId}] Listener error:`, err)
      }
    })
  }

  /**
   * Join WebSocket room and sync messages
   */
  private async _doJoin(options: RecoverOptions): Promise<void> {
    if (!this._socketContext) {
      console.error(`[TaskStateMachine:${this.taskId}] No socket context`)
      this._transition('JOIN_FAILURE')
      return
    }

    if (!this._socketContext.isConnected) {
      console.warn(`[TaskStateMachine:${this.taskId}] Socket not connected`)
      this._transition('JOIN_FAILURE')
      return
    }

    try {
      console.log(`[TaskStateMachine:${this.taskId}] Joining task room...`)
      const response = await this._socketContext.joinTask(this.taskId, true)

      if (response.error) {
        console.error(`[TaskStateMachine:${this.taskId}] Join failed:`, response.error)
        this._error = response.error
        this._transition('JOIN_FAILURE')
        return
      }

      this._isJoined = true
      this._streamingInfo = response.streaming || null

      if (response.streaming) {
        console.log(
          `[TaskStateMachine:${this.taskId}] Found streaming session:`,
          response.streaming.subtask_id,
          'content_len:',
          response.streaming.cached_content?.length || 0
        )
        this._streamingSubtaskId = response.streaming.subtask_id
      }

      this._transition('JOIN_SUCCESS')
      await this._doSync(options)
    } catch (err) {
      console.error(`[TaskStateMachine:${this.taskId}] Join error:`, err)
      this._error = (err as Error).message
      this._transition('JOIN_FAILURE')
    }
  }

  /**
   * Sync messages from subtasks
   */
  private async _doSync(options: RecoverOptions): Promise<void> {
    try {
      const subtasks = options.subtasks || []

      if (subtasks.length === 0) {
        console.log(`[TaskStateMachine:${this.taskId}] No subtasks to sync`)
        this._transition('SYNC_DONE')
        return
      }

      console.log(`[TaskStateMachine:${this.taskId}] Syncing ${subtasks.length} subtasks...`)

      // Build messages with content priority
      this._messages = buildMessages(subtasks, this._messages, this._streamingInfo, options)

      // Determine if streaming
      const hasStreaming = this._streamingInfo !== null || this._hasStreamingMessage()

      if (hasStreaming) {
        this._transition('SYNC_DONE_STREAMING')
      } else {
        this._transition('SYNC_DONE')
      }
    } catch (err) {
      console.error(`[TaskStateMachine:${this.taskId}] Sync error:`, err)
      this._error = (err as Error).message
      this._transition('SYNC_ERROR')
    }
  }

  /**
   * Check if any message is in streaming state
   */
  private _hasStreamingMessage(): boolean {
    for (const msg of this._messages.values()) {
      if (msg.type === 'ai' && msg.status === 'streaming') {
        return true
      }
    }
    return false
  }
}
