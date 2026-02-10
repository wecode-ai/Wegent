// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * TaskStateMachine
 *
 * A state machine for managing task message state with unified recovery mechanism.
 *
 * State Flow:
 * idle -> joining -> syncing -> ready <-> streaming
 *                      |           |
 *                    error <-------+
 *
 * This state machine consolidates all message recovery logic that was previously
 * scattered across:
 * - syncBackendMessages
 * - resumeStream
 * - useStreamingVisibilityRecovery
 * - SocketContext reconnect handler
 *
 * Key Features:
 * - Single source of truth for message state
 * - Built-in recovery debounce (1s by default)
 * - Content priority: Redis cached_content > existing message > Backend DB
 * - Queued recovery: RECOVER events during joining/syncing are queued
 */

import type { TaskDetailSubtask } from '@/types/api'
import type { MessageBlock } from '../components/message/thinking/types'

/**
 * Task state machine status
 */
export type TaskStatus =
  | 'idle' // Not joined WebSocket room
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
  subtaskId?: number
  messageId?: number
  error?: string
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
    sources?: Array<{
      index: number
      title: string
      kb_id: number
    }>
    reasoning_content?: string
    reasoning_chunk?: string
    blocks?: MessageBlock[]
  }
  sources?: Array<{
    index: number
    title: string
    kb_id: number
  }>
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
 * Pending chunk event to be applied after sync completes
 */
interface PendingChunkEvent {
  subtaskId: number
  content: string
  result?: UnifiedMessage['result']
  sources?: UnifiedMessage['sources']
  blockId?: string
}

/**
 * Task state data
 */
export interface TaskStateData {
  taskId: number
  status: TaskStatus
  messages: Map<string, UnifiedMessage>
  streamingSubtaskId: number | null
  streamingInfo: StreamingInfo | null
  error: string | null
  isStopping: boolean
}

/**
 * State machine events
 */
type Event =
  | { type: 'RECOVER'; force?: boolean }
  | { type: 'JOIN_SUCCESS'; streamingInfo?: StreamingInfo; subtasks?: TaskDetailSubtask[] }
  | { type: 'JOIN_FAILURE'; error: string }
  | { type: 'SYNC_DONE' }
  | { type: 'SYNC_DONE_STREAMING'; subtaskId: number }
  | { type: 'SYNC_ERROR'; error: string }
  | { type: 'CHAT_START'; subtaskId: number; shellType?: string }
  | {
      type: 'CHAT_CHUNK'
      subtaskId: number
      content: string
      result?: UnifiedMessage['result']
      sources?: UnifiedMessage['sources']
      blockId?: string
    }
  | {
      type: 'CHAT_DONE'
      subtaskId: number
      content?: string
      result?: UnifiedMessage['result']
      messageId?: number
      sources?: UnifiedMessage['sources']
      hasError?: boolean
      errorMessage?: string
    }
  | { type: 'CHAT_ERROR'; subtaskId: number; error: string; messageId?: number }
  | { type: 'CHAT_CANCELLED'; subtaskId: number }
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
export type StateListener = (state: TaskStateData) => void

/**
 * Dependencies injected from context
 */
export interface TaskStateMachineDeps {
  joinTask: (
    taskId: number,
    options?: {
      forceRefresh?: boolean
      afterMessageId?: number
    }
  ) => Promise<{
    streaming?: StreamingInfo
    /** Subtasks data for immediate message sync (same format as task detail API) */
    subtasks?: Array<Record<string, unknown>>
    error?: string
  }>
  isConnected: () => boolean
}

/**
 * Generate a unique message ID
 */
export function generateMessageId(type: 'user' | 'ai', subtaskId?: number): string {
  if (type === 'ai' && subtaskId) {
    return `ai-${subtaskId}`
  }
  return `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

/**
 * TaskStateMachine - manages message state for a single task
 */
export class TaskStateMachine {
  private state: TaskStateData
  private listeners: Set<StateListener> = new Set()
  private pendingRecovery: boolean = false
  private lastRecoveryTime: number = 0
  private recoveryDebounceMs: number = 1000
  private deps: TaskStateMachineDeps
  private syncOptions: SyncOptions = {}
  // Queue for chunk events received during syncing state
  // These will be applied after sync completes
  private pendingChunks: PendingChunkEvent[] = []

  constructor(taskId: number, deps: TaskStateMachineDeps) {
    this.state = {
      taskId,
      status: 'idle',
      messages: new Map(),
      streamingSubtaskId: null,
      streamingInfo: null,
      error: null,
      isStopping: false,
    }
    this.deps = deps
  }

  /**
   * Get current state (read-only copy)
   */
  getState(): TaskStateData {
    return { ...this.state, messages: new Map(this.state.messages) }
  }

  /**
   * Subscribe to state changes
   */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Set sync options (team name, group chat, etc.)
   */
  setSyncOptions(options: SyncOptions): void {
    this.syncOptions = options
  }

  /**
   * Get sync options (read-only copy)
   */
  getSyncOptions(): SyncOptions {
    return { ...this.syncOptions }
  }

  /**
   * Trigger message recovery
   *
   * Subtasks are now fetched from joinTask response, not passed as parameter.
   */
  async recover(options?: { force?: boolean }): Promise<void> {
    const event: Event = {
      type: 'RECOVER',
      force: options?.force,
    }
    await this.dispatch(event)
  }

  /**
   * Handle chat:start event
   */
  handleChatStart(subtaskId: number, shellType?: string): void {
    this.dispatch({ type: 'CHAT_START', subtaskId, shellType })
  }

  /**
   * Handle chat:chunk event
   */
  handleChatChunk(
    subtaskId: number,
    content: string,
    result?: UnifiedMessage['result'],
    sources?: UnifiedMessage['sources'],
    blockId?: string
  ): void {
    this.dispatch({ type: 'CHAT_CHUNK', subtaskId, content, result, sources, blockId })
  }

  /**
   * Handle chat:done event
   */
  handleChatDone(
    subtaskId: number,
    content?: string,
    result?: UnifiedMessage['result'],
    messageId?: number,
    sources?: UnifiedMessage['sources'],
    hasError?: boolean,
    errorMessage?: string
  ): void {
    this.dispatch({
      type: 'CHAT_DONE',
      subtaskId,
      content,
      result,
      messageId,
      sources,
      hasError,
      errorMessage,
    })
  }

  /**
   * Handle chat:error event
   */
  handleChatError(subtaskId: number, error: string, messageId?: number): void {
    this.dispatch({ type: 'CHAT_ERROR', subtaskId, error, messageId })
  }

  /**
   * Handle chat:cancelled event
   */
  handleChatCancelled(subtaskId: number): void {
    this.dispatch({ type: 'CHAT_CANCELLED', subtaskId })
  }

  /**
   * Leave the task room and reset state
   */
  leave(): void {
    this.dispatch({ type: 'LEAVE' })
  }

  /**
   * Add a user message (for sendMessage)
   */
  addUserMessage(message: UnifiedMessage): void {
    const newMessages = new Map(this.state.messages)
    newMessages.set(message.id, message)
    this.state = { ...this.state, messages: newMessages }
    this.notifyListeners()
  }

  /**
   * Update a user message (for sendMessage response)
   */
  updateUserMessage(messageId: string, updates: Partial<UnifiedMessage>): void {
    const existingMessage = this.state.messages.get(messageId)
    if (!existingMessage) return

    const newMessages = new Map(this.state.messages)
    newMessages.set(messageId, { ...existingMessage, ...updates })
    this.state = { ...this.state, messages: newMessages }
    this.notifyListeners()
  }

  /**
   * Clean up messages after edit (remove edited message and subsequent messages)
   */
  cleanupMessagesAfterEdit(editedSubtaskId: number): void {
    let editedMessageId: number | undefined
    for (const msg of this.state.messages.values()) {
      if (msg.subtaskId === editedSubtaskId) {
        editedMessageId = msg.messageId
        break
      }
    }

    if (editedMessageId === undefined) return

    const newMessages = new Map<string, UnifiedMessage>()
    for (const [msgId, msg] of this.state.messages) {
      if (msg.messageId === undefined || msg.messageId < editedMessageId) {
        newMessages.set(msgId, msg)
      }
    }

    this.state = { ...this.state, messages: newMessages }
    this.notifyListeners()
  }

  /**
   * Merge older messages into state (for pagination)
   * Only adds messages that don't already exist
   */
  mergeOlderMessages(messages: UnifiedMessage[]): void {
    if (messages.length === 0) return

    const newMessages = new Map(this.state.messages)
    let addedCount = 0

    for (const msg of messages) {
      // Only add if not already exists
      if (!newMessages.has(msg.id)) {
        newMessages.set(msg.id, msg)
        addedCount++
      }
    }

    if (addedCount > 0) {
      this.state = { ...this.state, messages: newMessages }
      this.notifyListeners()
    }
  }

  /**
   * Set stopping state
   */
  setStopping(isStopping: boolean): void {
    this.state = { ...this.state, isStopping }
    this.notifyListeners()
  }

  /**
   * Dispatch an event to the state machine
   */
  private async dispatch(event: Event): Promise<void> {
    const prevStatus = this.state.status

    switch (event.type) {
      case 'RECOVER':
        await this.handleRecover(event)
        break

      case 'JOIN_SUCCESS':
        if (prevStatus === 'joining') {
          this.state = {
            ...this.state,
            status: 'syncing',
            streamingInfo: event.streamingInfo || null,
          }
          // Sync messages immediately using subtasks from joinTask response
          await this.doSync(event.subtasks)
        }
        break

      case 'JOIN_FAILURE':
        if (prevStatus === 'joining') {
          this.state = { ...this.state, status: 'error', error: event.error }
        }
        break

      case 'SYNC_DONE':
        if (prevStatus === 'syncing') {
          this.state = { ...this.state, status: 'ready', streamingSubtaskId: null }
        }
        break

      case 'SYNC_DONE_STREAMING':
        if (prevStatus === 'syncing') {
          this.state = {
            ...this.state,
            status: 'streaming',
            streamingSubtaskId: event.subtaskId,
          }
        }
        break

      case 'SYNC_ERROR':
        if (prevStatus === 'syncing') {
          this.state = { ...this.state, status: 'error', error: event.error }
        }
        break

      case 'CHAT_START':
        this.handleChatStartEvent(event)
        break

      case 'CHAT_CHUNK':
        this.handleChatChunkEvent(event)
        break

      case 'CHAT_DONE':
        this.handleChatDoneEvent(event)
        break

      case 'CHAT_ERROR':
        this.handleChatErrorEvent(event)
        break

      case 'CHAT_CANCELLED':
        this.handleChatCancelledEvent(event)
        break

      case 'LEAVE':
        this.state = {
          ...this.state,
          status: 'idle',
          messages: new Map(),
          streamingSubtaskId: null,
          streamingInfo: null,
          error: null,
          isStopping: false,
        }
        this.pendingRecovery = false
        this.pendingChunks = [] // Clear pending chunks queue on leave
        break
    }

    this.notifyListeners()

    // Process queued recovery after reaching ready/streaming/error state
    if (
      this.pendingRecovery &&
      (this.state.status === 'ready' ||
        this.state.status === 'streaming' ||
        this.state.status === 'error')
    ) {
      this.pendingRecovery = false
      await this.recover({ force: true })
    }
  }

  /**
   * Handle RECOVER event
   *
   * Subtasks are fetched from joinTask response and passed to JOIN_SUCCESS event.
   * The doSync is called in JOIN_SUCCESS handler with the subtasks.
   */
  private async handleRecover(event: Extract<Event, { type: 'RECOVER' }>): Promise<void> {
    // Queue if in joining/syncing state
    if (this.state.status === 'joining' || this.state.status === 'syncing') {
      this.pendingRecovery = true
      return
    }

    // Debounce check
    const now = Date.now()
    if (!event.force && now - this.lastRecoveryTime < this.recoveryDebounceMs) {
      return
    }
    this.lastRecoveryTime = now

    // Check WebSocket connection
    if (!this.deps.isConnected()) {
      return
    }

    // Transition to joining
    this.state = { ...this.state, status: 'joining', error: null }
    this.notifyListeners()

    try {
      // Calculate max messageId from existing messages for incremental sync
      // This allows the backend to only return messages after this ID on reconnect
      let maxMessageId: number | undefined
      for (const msg of this.state.messages.values()) {
        if (
          msg.messageId !== undefined &&
          (maxMessageId === undefined || msg.messageId > maxMessageId)
        ) {
          maxMessageId = msg.messageId
        }
      }

      // Join WebSocket room and get streaming info + subtasks
      // Pass afterMessageId for incremental sync on reconnect
      const response = await this.deps.joinTask(this.state.taskId, {
        forceRefresh: true,
        afterMessageId: maxMessageId,
      })

      if (response.error) {
        await this.dispatch({ type: 'JOIN_FAILURE', error: response.error })
        return
      }

      // Pass subtasks to JOIN_SUCCESS event for immediate sync
      const subtasks = response.subtasks as TaskDetailSubtask[] | undefined

      await this.dispatch({
        type: 'JOIN_SUCCESS',
        streamingInfo: response.streaming,
        subtasks,
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      await this.dispatch({ type: 'JOIN_FAILURE', error: errorMsg })
    }
  }

  /**
   * Sync messages from backend subtasks
   */
  private async doSync(subtasks?: TaskDetailSubtask[]): Promise<void> {
    try {
      if (subtasks && subtasks.length > 0) {
        this.buildMessages(subtasks)
      }

      // CRITICAL: If streamingInfo exists but no streaming message was created,
      // create one now. This handles the case where:
      // 1. User joins room while streaming is in progress
      // 2. Backend returns streamingInfo with subtask_id and cached_content
      // 3. But subtasks array doesn't contain this subtask yet (race condition)
      // Without this, subsequent CHAT_CHUNK events would be ignored
      const streamingInfo = this.state.streamingInfo
      if (streamingInfo && streamingInfo.subtask_id) {
        const aiMessageId = generateMessageId('ai', streamingInfo.subtask_id)
        const existingMessage = this.state.messages.get(aiMessageId)

        // Create message if it doesn't exist
        if (!existingMessage) {
          const newMessages = new Map(this.state.messages)
          newMessages.set(aiMessageId, {
            id: aiMessageId,
            type: 'ai',
            status: 'streaming',
            content: streamingInfo.cached_content || '',
            timestamp: Date.now(),
            subtaskId: streamingInfo.subtask_id,
          })
          this.state = { ...this.state, messages: newMessages }
        } else if (
          existingMessage.status === 'streaming' &&
          streamingInfo.cached_content &&
          streamingInfo.cached_content.length > existingMessage.content.length
        ) {
          // Update existing message with longer cached_content from Redis
          // This handles the case where the message was created from subtasks
          // but Redis has more recent content

          const newMessages = new Map(this.state.messages)
          newMessages.set(aiMessageId, {
            ...existingMessage,
            content: streamingInfo.cached_content,
          })
          this.state = { ...this.state, messages: newMessages }
        }
      }

      // Check if any message is streaming
      let streamingSubtaskId: number | null = null
      for (const msg of this.state.messages.values()) {
        if (msg.type === 'ai' && msg.status === 'streaming') {
          streamingSubtaskId = msg.subtaskId || null
          break
        }
      }

      if (streamingSubtaskId) {
        await this.dispatch({ type: 'SYNC_DONE_STREAMING', subtaskId: streamingSubtaskId })
      } else {
        await this.dispatch({ type: 'SYNC_DONE' })
      }

      // Apply pending chunks that were queued during sync
      // This ensures chunks received during joining/syncing are not lost
      this.applyPendingChunks()
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Sync failed'
      await this.dispatch({ type: 'SYNC_ERROR', error: errorMsg })
    }
  }

  /**
   * Apply pending chunk events that were queued during sync
   */
  private applyPendingChunks(): void {
    if (this.pendingChunks.length === 0) {
      return
    }

    // Process each pending chunk
    for (const chunk of this.pendingChunks) {
      const aiMessageId = generateMessageId('ai', chunk.subtaskId)
      const existingMessage = this.state.messages.get(aiMessageId)

      if (!existingMessage) {
        console.warn('[TaskStateMachine] Pending chunk skipped - message not found', {
          subtaskId: chunk.subtaskId,
          taskId: this.state.taskId,
        })
        continue
      }

      // Apply the chunk to the message
      // CRITICAL FIX: Always append content to message.content, regardless of block_id
      // This ensures that cached_content + new chunks are all in message.content
      const newMessages = new Map(this.state.messages)
      const updatedMessage: UnifiedMessage = {
        ...existingMessage,
        content: existingMessage.content + chunk.content,
      }

      // Handle reasoning content
      if (chunk.result?.reasoning_chunk) {
        updatedMessage.reasoningContent =
          (existingMessage.reasoningContent || '') + chunk.result.reasoning_chunk
      } else if (chunk.result?.reasoning_content) {
        updatedMessage.reasoningContent = chunk.result.reasoning_content
      }

      // Handle blocks
      const mergedBlocks = this.mergeBlocksFromPendingChunk(existingMessage, chunk)

      if (chunk.result) {
        updatedMessage.result = {
          ...existingMessage.result,
          ...chunk.result,
          thinking: chunk.result.thinking || existingMessage.result?.thinking,
          blocks: mergedBlocks,
          reasoning_content:
            chunk.result.reasoning_content || existingMessage.result?.reasoning_content,
          shell_type: chunk.result.shell_type || existingMessage.result?.shell_type,
        }
      } else if (chunk.blockId && chunk.content) {
        updatedMessage.result = {
          ...existingMessage.result,
          blocks: mergedBlocks,
        }
      }

      if (chunk.sources) {
        updatedMessage.sources = chunk.sources
      }

      newMessages.set(aiMessageId, updatedMessage)
      this.state = { ...this.state, messages: newMessages }
    }

    // Clear the pending chunks queue
    this.pendingChunks = []
    this.notifyListeners()
  }

  /**
   * Merge blocks for pending chunk (similar to mergeBlocks but for PendingChunkEvent)
   */
  private mergeBlocksFromPendingChunk(
    existingMessage: UnifiedMessage,
    chunk: PendingChunkEvent
  ): MessageBlock[] {
    const existingBlocks = existingMessage.result?.blocks || []
    const incomingBlocks = chunk.result?.blocks || []

    // Case 1: block_id with content - text block update
    if (chunk.blockId && chunk.content) {
      const blocksMap = new Map(existingBlocks.map(b => [b.id, b]))
      const targetBlock = blocksMap.get(chunk.blockId)

      if (targetBlock && targetBlock.type === 'text') {
        const updatedBlock = {
          ...targetBlock,
          content: (targetBlock.content || '') + chunk.content,
        }
        blocksMap.set(chunk.blockId, updatedBlock)
      } else if (!targetBlock) {
        const newBlock: MessageBlock = {
          id: chunk.blockId,
          type: 'text',
          content: chunk.content,
          status: 'streaming',
          timestamp: Date.now(),
        }
        blocksMap.set(chunk.blockId, newBlock)
      }

      return Array.from(blocksMap.values())
    }

    // Case 2: No incoming blocks - keep existing
    if (incomingBlocks.length === 0) {
      return existingBlocks
    }

    // Case 3: Tool blocks - merge by block.id
    const blocksMap = new Map(existingBlocks.map(b => [b.id, b]))
    incomingBlocks.forEach(incomingBlock => {
      blocksMap.set(incomingBlock.id, incomingBlock)
    })

    return Array.from(blocksMap.values())
  }

  /**
   * Build messages from backend subtasks
   *
   * Content Priority for RUNNING AI messages:
   * 1. Redis cached_content (most recent, updated every 1s)
   * 2. Existing message content in state
   * 3. Backend DB subtask.result.value (least recent, updated every 5s)
   *
   * Choose the longest content.
   */
  private buildMessages(subtasks: TaskDetailSubtask[]): void {
    const { teamName, isGroupChat, currentUserId, currentUserName, forceClean } = this.syncOptions
    const streamingInfo = this.state.streamingInfo

    // Build set of valid subtask IDs
    const validSubtaskIds = new Set(subtasks.map(s => s.id))

    // Start with existing messages, optionally clean invalid ones
    let messages: Map<string, UnifiedMessage>
    if (forceClean && this.state.messages.size > 0) {
      messages = new Map()
      for (const [msgId, msg] of this.state.messages) {
        if (!msg.subtaskId || validSubtaskIds.has(msg.subtaskId)) {
          messages.set(msgId, msg)
        }
      }
    } else {
      messages = new Map(this.state.messages)
    }

    // Build existing subtaskIds and count user messages
    const existingSubtaskIds = new Set<number>()
    let existingUserMessageCount = 0
    for (const msg of messages.values()) {
      if (msg.subtaskId) {
        existingSubtaskIds.add(msg.subtaskId)
      }
      if (msg.type === 'user') {
        existingUserMessageCount++
      }
    }

    const incomingUserSubtasks = subtasks.filter(
      s => s.role === 'USER' || s.role?.toUpperCase() === 'USER'
    )

    for (const subtask of subtasks) {
      const isUserMessage = subtask.role === 'USER' || subtask.role?.toUpperCase() === 'USER'
      const messageId = isUserMessage ? `user-backend-${subtask.id}` : `ai-${subtask.id}`

      // Check for frontend error state
      const existingMessage = this.state.messages.get(messageId)
      const hasFrontendError =
        existingMessage && existingMessage.status === 'error' && existingMessage.error

      // Handle RUNNING AI messages with content priority
      // IMPORTANT: Always process RUNNING AI messages even if they already exist
      // This ensures Redis cached_content and better existing content are used
      if (!isUserMessage && subtask.status === 'RUNNING') {
        const existingAiMessage = messages.get(messageId)
        const backendContent = typeof subtask.result?.value === 'string' ? subtask.result.value : ''

        // Content priority: Redis > existing > backend
        let bestContent = backendContent

        // Check existing message content
        if (existingAiMessage && existingAiMessage.content.length > bestContent.length) {
          bestContent = existingAiMessage.content
        }

        // Check Redis cached content
        if (
          streamingInfo &&
          streamingInfo.subtask_id === subtask.id &&
          streamingInfo.cached_content &&
          streamingInfo.cached_content.length > bestContent.length
        ) {
          bestContent = streamingInfo.cached_content
        }

        messages.set(messageId, {
          id: messageId,
          type: 'ai',
          status: hasFrontendError ? 'error' : 'streaming',
          content: bestContent,
          timestamp: existingAiMessage?.timestamp || new Date(subtask.created_at).getTime(),
          subtaskId: subtask.id,
          messageId: subtask.message_id,
          attachments: subtask.attachments,
          contexts: subtask.contexts,
          botName: subtask.bots?.[0]?.name || teamName,
          subtaskStatus: subtask.status,
          result: subtask.result as UnifiedMessage['result'],
          error: hasFrontendError ? existingMessage?.error : undefined,
          // Preserve existing reasoning content if present
          reasoningContent: existingAiMessage?.reasoningContent,
        })
        continue
      }

      // Skip if already exists by message ID (for non-RUNNING messages)
      if (messages.has(messageId)) {
        continue
      }

      // Skip if already exists by subtaskId (for non-RUNNING messages)
      if (existingSubtaskIds.has(subtask.id)) {
        continue
      }

      // Skip USER messages if we already have enough
      if (isUserMessage && existingUserMessageCount >= incomingUserSubtasks.length) {
        continue
      }

      // Skip PENDING AI messages
      if (!isUserMessage && subtask.status === 'PENDING') {
        continue
      }

      // Determine status
      let status: MessageStatus = 'completed'
      if (subtask.status === 'FAILED' || subtask.status === 'CANCELLED') {
        status = 'error'
      } else if (hasFrontendError) {
        status = 'error'
      }

      // Get content
      const content = isUserMessage
        ? subtask.prompt || ''
        : typeof subtask.result?.value === 'string'
          ? subtask.result.value
          : ''

      const errorField = hasFrontendError
        ? existingMessage?.error
        : subtask.error_message || undefined

      messages.set(messageId, {
        id: messageId,
        type: isUserMessage ? 'user' : 'ai',
        status,
        content,
        timestamp: new Date(subtask.created_at).getTime(),
        subtaskId: subtask.id,
        messageId: subtask.message_id,
        attachments: subtask.attachments,
        contexts: subtask.contexts,
        botName: !isUserMessage && subtask.bots?.[0]?.name ? subtask.bots[0].name : teamName,
        senderUserName:
          subtask.sender_user_name ||
          (isUserMessage && subtask.sender_user_id === currentUserId ? currentUserName : undefined),
        senderUserId: subtask.sender_user_id || (isUserMessage ? currentUserId : undefined),
        shouldShowSender: isGroupChat && isUserMessage,
        subtaskStatus: subtask.status,
        result: subtask.result as UnifiedMessage['result'],
        error: errorField,
      })
    }

    this.state = { ...this.state, messages }
  }

  /**
   * Handle CHAT_START event
   */
  private handleChatStartEvent(event: Extract<Event, { type: 'CHAT_START' }>): void {
    const aiMessageId = generateMessageId('ai', event.subtaskId)
    const initialResult = event.shellType ? { shell_type: event.shellType } : undefined

    const newMessages = new Map(this.state.messages)
    newMessages.set(aiMessageId, {
      id: aiMessageId,
      type: 'ai',
      status: 'streaming',
      content: '',
      timestamp: Date.now(),
      subtaskId: event.subtaskId,
      result: initialResult,
    })

    this.state = {
      ...this.state,
      status: 'streaming',
      streamingSubtaskId: event.subtaskId,
      messages: newMessages,
    }
  }

  /**
   * Get AI message for a subtask if it exists.
   * All messages should be created by server events (chat:start), not by frontend.
   *
   * @param subtaskId - The subtask ID
   * @returns The existing message or undefined
   */
  private getAiMessage(subtaskId: number): UnifiedMessage | undefined {
    const aiMessageId = generateMessageId('ai', subtaskId)
    const existingMessage = this.state.messages.get(aiMessageId)

    return existingMessage
  }

  /**
   * Handle CHAT_CHUNK event
   */
  private handleChatChunkEvent(event: Extract<Event, { type: 'CHAT_CHUNK' }>): void {
    const aiMessageId = generateMessageId('ai', event.subtaskId)

    // If in joining/syncing state, queue the chunk for later processing
    // This handles the race condition where chunks arrive before sync completes
    if (this.state.status === 'joining' || this.state.status === 'syncing') {
      this.pendingChunks.push({
        subtaskId: event.subtaskId,
        content: event.content,
        result: event.result,
        sources: event.sources,
        blockId: event.blockId,
      })
      return
    }

    // Get existing message - all messages should be created by server (chat:start)
    const existingMessage = this.getAiMessage(event.subtaskId)

    // If message doesn't exist, ignore this chunk
    // This can happen if chat:start was missed or not yet received
    if (!existingMessage) {
      console.warn(
        '[TaskStateMachine] CHAT_CHUNK ignored - message not found, waiting for chat:start',
        {
          subtaskId: event.subtaskId,
          taskId: this.state.taskId,
        }
      )
      return
    }

    const newMessages = new Map(this.state.messages)
    // CRITICAL FIX: Always append content to message.content, regardless of block_id
    // This ensures that:
    // 1. When page refreshes, cached_content is in message.content
    // 2. New chunks are appended to message.content
    // 3. UI can render from either message.content or result.blocks
    // Previously, when block_id existed, content was only added to blocks, causing
    // the UI to lose the cached_content after page refresh
    const updatedMessage: UnifiedMessage = {
      ...existingMessage,
      content: existingMessage.content + event.content,
    }

    // Handle reasoning content
    if (event.result?.reasoning_chunk) {
      updatedMessage.reasoningContent =
        (existingMessage.reasoningContent || '') + event.result.reasoning_chunk
    } else if (event.result?.reasoning_content) {
      updatedMessage.reasoningContent = event.result.reasoning_content
    }

    // Handle blocks
    const mergedBlocks = this.mergeBlocks(existingMessage, event)

    if (event.result) {
      updatedMessage.result = {
        ...existingMessage.result,
        ...event.result,
        thinking: event.result.thinking || existingMessage.result?.thinking,
        blocks: mergedBlocks,
        reasoning_content:
          event.result.reasoning_content || existingMessage.result?.reasoning_content,
        shell_type: event.result.shell_type || existingMessage.result?.shell_type,
      }
    } else if (event.blockId && event.content) {
      updatedMessage.result = {
        ...existingMessage.result,
        blocks: mergedBlocks,
      }
    }

    if (event.sources) {
      updatedMessage.sources = event.sources
    }

    newMessages.set(aiMessageId, updatedMessage)
    this.state = { ...this.state, messages: newMessages }

    // CRITICAL: Notify listeners after updating state
    // Without this, UI won't update when receiving chunks
    this.notifyListeners()
  }

  /**
   * Merge blocks for incremental updates
   */
  private mergeBlocks(
    existingMessage: UnifiedMessage,
    event: Extract<Event, { type: 'CHAT_CHUNK' }>
  ): MessageBlock[] {
    const existingBlocks = existingMessage.result?.blocks || []
    const incomingBlocks = event.result?.blocks || []

    // Case 1: block_id with content - text block update
    if (event.blockId && event.content) {
      const blocksMap = new Map(existingBlocks.map(b => [b.id, b]))
      const targetBlock = blocksMap.get(event.blockId)

      if (targetBlock && targetBlock.type === 'text') {
        const updatedBlock = {
          ...targetBlock,
          content: (targetBlock.content || '') + event.content,
        }
        blocksMap.set(event.blockId, updatedBlock)
      } else if (!targetBlock) {
        const newBlock: MessageBlock = {
          id: event.blockId,
          type: 'text',
          content: event.content,
          status: 'streaming',
          timestamp: Date.now(),
        }
        blocksMap.set(event.blockId, newBlock)
      }

      return Array.from(blocksMap.values())
    }

    // Case 2: No incoming blocks - keep existing
    if (incomingBlocks.length === 0) {
      return existingBlocks
    }

    // Case 3: Tool blocks - merge by block.id
    const blocksMap = new Map(existingBlocks.map(b => [b.id, b]))
    incomingBlocks.forEach(incomingBlock => {
      blocksMap.set(incomingBlock.id, incomingBlock)
    })

    return Array.from(blocksMap.values())
  }

  /**
   * Handle CHAT_DONE event
   */
  private handleChatDoneEvent(event: Extract<Event, { type: 'CHAT_DONE' }>): void {
    const aiMessageId = generateMessageId('ai', event.subtaskId)
    let existingMessage = this.state.messages.get(aiMessageId)

    if (!existingMessage) {
      // Page refresh recovery: create AI message if it doesn't exist
      // This handles the case where chat:start/chunk were sent before page refresh
      // and we only receive chat:done after reconnecting

      existingMessage = {
        id: aiMessageId,
        type: 'ai',
        status: 'streaming', // Will be updated below
        content: event.content || (event.result?.value as string) || '',
        timestamp: Date.now(),
        subtaskId: event.subtaskId,
        result: event.result,
        sources: event.sources,
      }
    }

    const finalStatus = event.hasError ? 'error' : 'completed'
    const finalSubtaskStatus = event.hasError ? 'FAILED' : 'COMPLETED'

    const newMessages = new Map(this.state.messages)
    newMessages.set(aiMessageId, {
      ...existingMessage,
      status: finalStatus,
      subtaskStatus: finalSubtaskStatus,
      content: event.content || existingMessage.content,
      error: event.hasError ? event.errorMessage : existingMessage.error,
      messageId: event.messageId,
      sources: event.sources || existingMessage.sources,
      result: event.result
        ? {
            ...existingMessage.result,
            ...event.result,
            thinking: event.result.thinking || existingMessage.result?.thinking,
            blocks: event.result.blocks || existingMessage.result?.blocks,
          }
        : existingMessage.result,
    })

    // Update status to ready if this was the streaming subtask
    const newStatus =
      this.state.status === 'streaming' && this.state.streamingSubtaskId === event.subtaskId
        ? 'ready'
        : this.state.status

    this.state = {
      ...this.state,
      status: newStatus,
      streamingSubtaskId: newStatus === 'ready' ? null : this.state.streamingSubtaskId,
      messages: newMessages,
      isStopping: false,
    }
  }

  /**
   * Handle CHAT_ERROR event
   */
  private handleChatErrorEvent(event: Extract<Event, { type: 'CHAT_ERROR' }>): void {
    const aiMessageId = generateMessageId('ai', event.subtaskId)
    const existingMessage = this.state.messages.get(aiMessageId)

    if (!existingMessage) {
      console.warn('[TaskStateMachine] CHAT_ERROR for unknown message', event.subtaskId)
      return
    }

    const newMessages = new Map(this.state.messages)
    newMessages.set(aiMessageId, {
      ...existingMessage,
      status: 'error',
      subtaskStatus: 'FAILED',
      error: event.error,
      messageId: event.messageId ?? existingMessage.messageId,
    })

    this.state = {
      ...this.state,
      status: 'error',
      messages: newMessages,
      error: event.error,
      isStopping: false,
    }
  }

  /**
   * Handle CHAT_CANCELLED event
   */
  private handleChatCancelledEvent(event: Extract<Event, { type: 'CHAT_CANCELLED' }>): void {
    const aiMessageId = generateMessageId('ai', event.subtaskId)
    const existingMessage = this.state.messages.get(aiMessageId)

    if (!existingMessage) return

    const newMessages = new Map(this.state.messages)
    newMessages.set(aiMessageId, {
      ...existingMessage,
      status: 'completed',
      subtaskStatus: 'CANCELLED',
    })

    const newStatus =
      this.state.status === 'streaming' && this.state.streamingSubtaskId === event.subtaskId
        ? 'ready'
        : this.state.status

    this.state = {
      ...this.state,
      status: newStatus,
      streamingSubtaskId: newStatus === 'ready' ? null : this.state.streamingSubtaskId,
      messages: newMessages,
      isStopping: false,
    }
  }

  /**
   * Notify all listeners of state change
   */
  private notifyListeners(): void {
    const stateCopy = this.getState()

    this.listeners.forEach(listener => {
      try {
        listener(stateCopy)
      } catch (err) {
        console.error('[TaskStateMachine] Error in listener:', err)
      }
    })
  }
}
