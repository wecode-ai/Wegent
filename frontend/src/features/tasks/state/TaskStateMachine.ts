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

import type { TaskDetail, TaskDetailSubtask, TaskStatus as ApiTaskStatus } from '@/types/api'
import type { MessageBlock } from '../components/message/thinking/types'
import { mergeBlocksForDone, mergeStreamingBlocks } from './TaskStateMachine.blockMerging'
import {
  getRuntimePhaseForTaskStatus,
  isActiveExecutionTaskStatus,
  isTerminalTaskStatus,
  isWaitingForUserTaskStatus,
  type TaskRuntimePhase,
} from './taskStatusClassifier'

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
  subtaskId?: number
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
interface PendingChunkEvent {
  subtaskId: number
  content: string
  offset?: number
  result?: UnifiedMessage['result']
  sources?: UnifiedMessage['sources']
  blockId?: string
}

interface TaskMachineInternalState {
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
type Event =
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
      type: 'JOIN_SUCCESS'
      streamRecovery?: StreamingRecoveryPayload
      subtasks?: TaskDetailSubtask[]
      syncUpdatedAt?: string
    }
  | { type: 'JOIN_FAILURE'; error: string }
  | { type: 'SYNC_DONE'; syncUpdatedAt?: string }
  | {
      type: 'SYNC_DONE_STREAMING'
      subtaskId: number
      cursor: number
      startedAt?: string
      lastActivityAt?: string
      syncUpdatedAt?: string
    }
  | { type: 'SYNC_ERROR'; error: string }
  | { type: 'CHAT_START'; subtaskId: number; shellType?: string; messageId?: number }
  | {
      type: 'CHAT_CHUNK'
      subtaskId: number
      content: string
      offset?: number
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
  | { type: 'CHAT_ERROR'; subtaskId: number; error: string; messageId?: number; errorType?: string }
  | { type: 'CHAT_CANCELLED'; subtaskId: number }
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

function mergeChunkContent(
  existingContent: string,
  incomingContent: string,
  offset?: number
): { content: string; appendedContent: string } {
  if (!incomingContent) {
    return { content: existingContent, appendedContent: '' }
  }

  if (offset === undefined || offset < 0) {
    return {
      content: existingContent + incomingContent,
      appendedContent: incomingContent,
    }
  }

  const replaceTail = () => {
    const content = existingContent.slice(0, offset) + incomingContent
    return {
      content,
      appendedContent:
        content.length > existingContent.length ? content.slice(existingContent.length) : '',
    }
  }

  if (offset > existingContent.length) {
    return replaceTail()
  }

  const existingAtOffset = existingContent.slice(offset, offset + incomingContent.length)
  if (existingAtOffset === incomingContent) {
    return { content: existingContent, appendedContent: '' }
  }

  if (offset < existingContent.length) {
    const overlapLength = existingContent.length - offset
    const existingOverlap = existingContent.slice(offset)
    const incomingOverlap = incomingContent.slice(0, overlapLength)

    if (existingOverlap === incomingOverlap) {
      const appendedContent = incomingContent.slice(overlapLength)
      return {
        content: existingContent + appendedContent,
        appendedContent,
      }
    }

    return replaceTail()
  }

  return {
    content: existingContent + incomingContent,
    appendedContent: incomingContent,
  }
}

/**
 * TaskStateMachine - manages message state for a single task
 */
export class TaskStateMachine {
  private state: TaskMachineInternalState
  private listeners: Set<StateListener> = new Set()
  private pendingRecovery: boolean = false
  private pendingRecoveryReason?: TaskRecoveryReason
  private pendingRecoveryOptions?: {
    resumeFromCursor?: number
    activeStreamSubtaskId?: number
    syncAfterMessageId?: number
  }
  private lastRecoveryTime: number = 0
  private recoveryDebounceMs: number = 1000
  private deps: TaskStateMachineDeps
  private syncOptions: SyncOptions = {}
  private closed: boolean = false
  private recoveryVersion: number = 0
  // Queue for chunk events received during syncing state
  // These will be applied after sync completes
  private pendingChunks: PendingChunkEvent[] = []

  constructor(taskId: number, deps: TaskStateMachineDeps) {
    const runtime: TaskRuntimeState = {
      taskId,
      phase: 'unknown',
      joinedRoom: false,
      localStreamCursor: 0,
    }

    this.state = {
      taskId,
      status: 'idle',
      messages: new Map(),
      error: null,
      isStopping: false,
      runtime,
      derived: this.deriveRuntimeState(runtime),
    }
    this.deps = deps
  }

  updateDeps(deps: TaskStateMachineDeps): void {
    this.deps = deps
  }

  renameTaskId(taskId: number): void {
    if (taskId === this.state.taskId) return

    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      taskId,
    }

    this.state = {
      ...this.state,
      taskId,
      runtime,
      derived: this.deriveRuntimeState(runtime),
    }

    this.notifyListeners()
  }

  private deriveRuntimeState(runtime: TaskRuntimeState): TaskRuntimeDerivedState {
    const isExecutionActive = isActiveExecutionTaskStatus(runtime.taskStatus)
    const isTerminal = isTerminalTaskStatus(runtime.taskStatus)
    const isWaitingForUser = isWaitingForUserTaskStatus(runtime.taskStatus)
    const isStreaming = runtime.phase === 'streaming' && Boolean(runtime.activeStreamSubtaskId)

    return {
      isExecutionActive,
      isTerminal,
      isStreaming,
      shouldJoinRoom: isExecutionActive && !runtime.joinedRoom,
      canSendMessage: isTerminal || isWaitingForUser || runtime.phase === 'running',
      canQueueMessage: isStreaming,
      canCancelTask: isExecutionActive && !isTerminal,
      blocksQueuedDispatch: isExecutionActive,
    }
  }

  /**
   * Get current state (read-only copy)
   */
  getState(): TaskStateSnapshot {
    return {
      taskId: this.state.taskId,
      phase: this.state.status,
      messages: new Map(this.state.messages),
      error: this.state.error,
      isStopping: this.state.isStopping,
      runtime: { ...this.state.runtime },
      derived: { ...this.state.derived },
    }
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
  async recover(options?: {
    force?: boolean
    reason?: TaskRecoveryReason
    resumeFromCursor?: number
    activeStreamSubtaskId?: number
    syncAfterMessageId?: number
    syncUpdatedAt?: string
  }): Promise<void> {
    const event: Event = {
      type: 'RECOVER',
      force: options?.force,
      reason: options?.reason,
      resumeFromCursor: options?.resumeFromCursor,
      activeStreamSubtaskId: options?.activeStreamSubtaskId,
      syncAfterMessageId: options?.syncAfterMessageId,
      syncUpdatedAt: options?.syncUpdatedAt,
    }
    await this.dispatch(event)
  }

  async openTask(): Promise<void> {
    this.closed = false
    const detailPromise = this.deps.pullTaskDetail
      ? this.deps
          .pullTaskDetail(this.state.taskId)
          .then(taskDetail => {
            if (taskDetail) {
              this.loadTask(taskDetail)
            }
          })
          .catch(error => {
            console.error('[TaskStateMachine] pullTaskDetail failed:', error)
          })
      : Promise.resolve()

    const joinPromise = this.recover({ force: true, reason: 'task-selected' })

    await Promise.allSettled([detailPromise, joinPromise])
  }

  closeTask(): void {
    this.closed = true
    this.recoveryVersion += 1
    this.deps.leaveTask?.(this.state.taskId)
    this.leave()
  }

  loadTask(taskDetail: Pick<TaskDetail, 'id' | 'status' | 'updated_at'>): void {
    if (taskDetail.id !== this.state.taskId) return
    this.applyTaskLifecycleStatus(taskDetail.status, taskDetail.updated_at)
    this.notifyListeners()
  }

  async checkHealth(reason: TaskRecoveryReason): Promise<void> {
    if (!this.deps.isConnected()) return
    if (!this.deps.pullRuntime) {
      throw new Error('[TaskStateMachine] pullRuntime action is required for checkHealth().')
    }

    const server = await this.deps.pullRuntime(this.state.taskId)
    if (!server) return
    await this.reconcileRuntime(server, reason)
  }

  async handleSocketConnected(reason: TaskRecoveryReason): Promise<void> {
    await this.checkHealth(reason)
  }

  async reconcileRuntime(
    server: TaskRuntimeVerifyResult,
    reason: TaskRecoveryReason
  ): Promise<void> {
    if (!this.deps.isConnected()) return
    const syncAfterMessageId = server.active_stream
      ? undefined
      : this.getSyncAfterMessageIdBeforeSubtask(this.state.runtime.activeStreamSubtaskId)
    this.applyTaskLifecycleStatus(server.task_status, server.status_updated_at ?? undefined)

    const shouldJoinOrResume = this.shouldJoinOrResume(server)
    this.recordRuntimeVerification(server)

    if (shouldJoinOrResume) {
      await this.joinOrResumeFromRuntime(server, reason, syncAfterMessageId)
      return
    }

    if (!server.active_stream && this.state.runtime.activeStreamSubtaskId !== undefined) {
      this.clearLocalStream()
    }

    this.notifyListeners()
  }

  handleTaskStatus(taskStatus: ApiTaskStatus, updatedAt?: string): void {
    this.dispatch({
      type: 'TASK_STATUS_RECEIVED',
      taskStatus,
      updatedAt,
    })
  }

  markSendAccepted(acceptedAt: string = new Date().toISOString()): void {
    this.dispatch({
      type: 'SEND_ACCEPTED',
      acceptedAt,
    })
  }

  syncTaskDetail(taskDetail: Pick<TaskDetail, 'id' | 'status' | 'updated_at'>): void {
    this.loadTask(taskDetail)
  }

  /**
   * Handle chat:start event
   */
  handleChatStart(subtaskId: number, shellType?: string, messageId?: number): void {
    this.dispatch({ type: 'CHAT_START', subtaskId, shellType, messageId })
  }

  /**
   * Handle chat:chunk event
   */
  handleChatChunk(
    subtaskId: number,
    content: string,
    result?: UnifiedMessage['result'],
    sources?: UnifiedMessage['sources'],
    blockId?: string,
    offset?: number
  ): void {
    this.dispatch({ type: 'CHAT_CHUNK', subtaskId, content, offset, result, sources, blockId })
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
  handleChatError(subtaskId: number, error: string, messageId?: number, errorType?: string): void {
    this.dispatch({ type: 'CHAT_ERROR', subtaskId, error, messageId, errorType })
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
   * Set stopping state
   */
  setStopping(isStopping: boolean): void {
    this.state = { ...this.state, isStopping }
    this.notifyListeners()
  }

  private recordRuntimeVerification(server: TaskRuntimeVerifyResult): void {
    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      lastVerifiedAt: Date.now(),
      lastVerifiedServerCursor: server.active_stream?.cursor,
    }
    this.state = {
      ...this.state,
      runtime,
      derived: this.deriveRuntimeState(runtime),
    }
  }

  private shouldJoinOrResume(server: TaskRuntimeVerifyResult): boolean {
    const serverUpdatedAt = server.status_updated_at ?? undefined
    if (serverUpdatedAt && this.state.runtime.messagesSyncedUpdatedAt !== serverUpdatedAt) {
      return true
    }

    if (!isActiveExecutionTaskStatus(server.task_status)) return false
    if (!server.active_stream) return !this.state.runtime.joinedRoom
    if (!this.state.runtime.joinedRoom) return true
    if (this.state.runtime.activeStreamSubtaskId !== server.active_stream.subtask_id) return true

    const serverCursor = server.active_stream.cursor
    const localCursor = this.state.runtime.localStreamCursor
    const previousServerCursor = this.state.runtime.lastVerifiedServerCursor ?? serverCursor
    const localLastChunkAt = this.state.runtime.localLastChunkAt ?? 0
    const serverIsProgressing = serverCursor > previousServerCursor
    const localIsStalled = Date.now() - localLastChunkAt > 10000
    return serverCursor > localCursor && serverIsProgressing && localIsStalled
  }

  private async joinOrResumeFromRuntime(
    server: TaskRuntimeVerifyResult,
    reason: TaskRecoveryReason,
    syncAfterMessageId?: number
  ): Promise<void> {
    const options: Parameters<TaskStateMachine['recover']>[0] = {
      force: true,
      reason,
      syncUpdatedAt: server.status_updated_at ?? undefined,
      syncAfterMessageId,
    }

    if (server.active_stream) {
      options.resumeFromCursor = this.state.runtime.localStreamCursor
      options.activeStreamSubtaskId = server.active_stream.subtask_id
    }

    await this.recover(options)
  }

  private getSyncAfterMessageIdBeforeSubtask(subtaskId?: number): number | undefined {
    if (subtaskId === undefined) return undefined

    const activeMessage = this.state.messages.get(generateMessageId('ai', subtaskId))
    const activeMessageId = activeMessage?.messageId
    if (activeMessageId === undefined) return undefined

    let syncAfterMessageId: number | undefined
    for (const message of this.state.messages.values()) {
      if (message.messageId === undefined || message.messageId >= activeMessageId) continue
      if (syncAfterMessageId === undefined || message.messageId > syncAfterMessageId) {
        syncAfterMessageId = message.messageId
      }
    }

    return syncAfterMessageId
  }

  private clearLocalStream(): void {
    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      phase: getRuntimePhaseForTaskStatus(this.state.runtime.taskStatus, false),
      activeStreamSubtaskId: undefined,
      activeStreamStartedAt: undefined,
      activeStreamLastActivityAt: undefined,
      localStreamCursor: 0,
    }
    this.state = {
      ...this.state,
      status: 'ready',
      runtime,
      derived: this.deriveRuntimeState(runtime),
    }
  }

  private applyTaskLifecycleStatus(taskStatus: ApiTaskStatus, updatedAt?: string): void {
    if (this.shouldDeferLifecycleStatus(taskStatus)) {
      const runtime: TaskRuntimeState = {
        ...this.state.runtime,
        deferredTerminalStatus: taskStatus,
        deferredTerminalUpdatedAt: updatedAt,
      }
      this.state = {
        ...this.state,
        runtime,
        derived: this.deriveRuntimeState(runtime),
      }
      return
    }

    if (this.shouldIgnoreLifecycleStatus(taskStatus, updatedAt)) return

    const isTerminal = isTerminalTaskStatus(taskStatus)
    const activeStreamSubtaskId = isTerminal ? undefined : this.state.runtime.activeStreamSubtaskId
    const phase = getRuntimePhaseForTaskStatus(taskStatus, Boolean(activeStreamSubtaskId))
    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      taskId: this.state.taskId,
      taskStatus,
      phase,
      activeStreamSubtaskId,
      activeStreamStartedAt: isTerminal ? undefined : this.state.runtime.activeStreamStartedAt,
      activeStreamLastActivityAt: isTerminal
        ? undefined
        : this.state.runtime.activeStreamLastActivityAt,
      lastStatusUpdatedAt: updatedAt ?? this.state.runtime.lastStatusUpdatedAt,
      lastTerminalStatusUpdatedAt: isTerminal
        ? (updatedAt ?? this.state.runtime.lastTerminalStatusUpdatedAt)
        : this.state.runtime.lastTerminalStatusUpdatedAt,
      hasTerminalStatus: isTerminal ? true : this.state.runtime.hasTerminalStatus,
      deferredTerminalStatus:
        isTerminal || isActiveExecutionTaskStatus(taskStatus)
          ? undefined
          : this.state.runtime.deferredTerminalStatus,
      deferredTerminalUpdatedAt:
        isTerminal || isActiveExecutionTaskStatus(taskStatus)
          ? undefined
          : this.state.runtime.deferredTerminalUpdatedAt,
    }

    let messages = this.state.messages
    if (isTerminal) {
      messages = this.finalizeStreamingMessagesForTerminal(taskStatus)
      this.pendingChunks = []
    }

    const shouldPreserveMessageRecoveryPhase =
      isTerminal &&
      (this.state.status === 'waiting_socket' ||
        this.state.status === 'joining' ||
        this.state.status === 'syncing')

    this.state = {
      ...this.state,
      status: isTerminal && !shouldPreserveMessageRecoveryPhase ? 'ready' : this.state.status,
      isStopping: isTerminal ? false : this.state.isStopping,
      messages,
      runtime,
      derived: this.deriveRuntimeState(runtime),
    }
  }

  private shouldIgnoreLifecycleStatus(taskStatus: ApiTaskStatus, updatedAt?: string): boolean {
    const previousUpdatedAt = this.state.runtime.lastStatusUpdatedAt
    const previousStatus = this.state.runtime.taskStatus

    if (isTerminalTaskStatus(previousStatus) && isActiveExecutionTaskStatus(taskStatus)) {
      return true
    }

    if (previousUpdatedAt && updatedAt) {
      const previousTime = Date.parse(previousUpdatedAt)
      const nextTime = Date.parse(updatedAt)
      if (!Number.isNaN(previousTime) && !Number.isNaN(nextTime)) {
        if (nextTime < previousTime) return true
        if (
          nextTime === previousTime &&
          isTerminalTaskStatus(taskStatus) &&
          updatedAt === this.state.runtime.lastTerminalStatusUpdatedAt &&
          this.state.runtime.phase === 'streaming' &&
          this.state.runtime.activeStreamSubtaskId !== undefined
        ) {
          return true
        }
      }
    }

    return false
  }

  private shouldDeferLifecycleStatus(taskStatus: ApiTaskStatus): boolean {
    return (
      isTerminalTaskStatus(taskStatus) &&
      this.state.runtime.phase === 'streaming' &&
      this.state.runtime.activeStreamSubtaskId !== undefined &&
      this.state.runtime.hasTerminalStatus === true &&
      !this.state.runtime.lastTerminalStatusUpdatedAt
    )
  }

  private applyDeferredTerminalRuntime(runtime: TaskRuntimeState): TaskRuntimeState {
    if (!runtime.deferredTerminalStatus) return runtime

    return {
      ...runtime,
      taskStatus: runtime.deferredTerminalStatus,
      phase: 'terminal',
      activeStreamSubtaskId: undefined,
      lastStatusUpdatedAt: runtime.deferredTerminalUpdatedAt ?? runtime.lastStatusUpdatedAt,
      lastTerminalStatusUpdatedAt:
        runtime.deferredTerminalUpdatedAt ?? runtime.lastTerminalStatusUpdatedAt,
      hasTerminalStatus: true,
      deferredTerminalStatus: undefined,
      deferredTerminalUpdatedAt: undefined,
    }
  }

  private finalizeStreamingMessagesForTerminal(
    taskStatus: ApiTaskStatus
  ): Map<string, UnifiedMessage> {
    const messages = new Map(this.state.messages)
    const finalMessageStatus: MessageStatus =
      taskStatus === 'FAILED' || taskStatus === 'CANCELLED' ? 'error' : 'completed'
    const finalSubtaskStatus =
      taskStatus === 'FAILED' || taskStatus === 'CANCELLED' ? taskStatus : 'COMPLETED'

    messages.forEach((message, id) => {
      if (message.type !== 'ai' || message.status !== 'streaming') return
      messages.set(id, {
        ...message,
        status: finalMessageStatus,
        subtaskStatus: finalSubtaskStatus,
        isReasoningStreaming: false,
      })
    })

    return messages
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
        if (prevStatus !== 'idle') {
          const runtime: TaskRuntimeState = {
            ...this.state.runtime,
            joinedRoom: true,
            recoveryError: undefined,
          }
          this.state = {
            ...this.state,
            status: 'syncing',
            runtime,
            derived: this.deriveRuntimeState(runtime),
          }
          // Sync messages immediately using subtasks from joinTask response
          await this.doSync(event.subtasks, event.syncUpdatedAt, event.streamRecovery)
        }
        break

      case 'JOIN_FAILURE':
        if (prevStatus === 'joining') {
          const runtime: TaskRuntimeState = {
            ...this.state.runtime,
            recoveryError: event.error,
          }
          this.state = {
            ...this.state,
            status: 'error',
            error: event.error,
            runtime,
            derived: this.deriveRuntimeState(runtime),
          }
        }
        break

      case 'SYNC_DONE':
        if (prevStatus === 'syncing') {
          const runtime: TaskRuntimeState = {
            ...this.state.runtime,
            phase: getRuntimePhaseForTaskStatus(this.state.runtime.taskStatus, false),
            activeStreamSubtaskId: undefined,
            activeStreamStartedAt: undefined,
            activeStreamLastActivityAt: undefined,
            localStreamCursor: 0,
            lastSyncedAt: Date.now(),
            messagesSyncedUpdatedAt:
              event.syncUpdatedAt ?? this.state.runtime.messagesSyncedUpdatedAt,
          }
          this.state = {
            ...this.state,
            status: 'ready',
            runtime,
            derived: this.deriveRuntimeState(runtime),
          }
        }
        break

      case 'SYNC_DONE_STREAMING':
        if (prevStatus === 'syncing') {
          const runtime: TaskRuntimeState = {
            ...this.state.runtime,
            phase: getRuntimePhaseForTaskStatus(this.state.runtime.taskStatus, true),
            activeStreamSubtaskId: event.subtaskId,
            activeStreamStartedAt: event.startedAt,
            activeStreamLastActivityAt: event.lastActivityAt,
            localStreamCursor: event.cursor,
            localLastChunkAt: Date.now(),
            lastSyncedAt: Date.now(),
            messagesSyncedUpdatedAt:
              event.syncUpdatedAt ?? this.state.runtime.messagesSyncedUpdatedAt,
          }
          this.state = {
            ...this.state,
            status: 'streaming',
            runtime,
            derived: this.deriveRuntimeState(runtime),
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

      case 'SEND_ACCEPTED':
        this.handleSendAcceptedEvent(event)
        break

      case 'TASK_STATUS_RECEIVED':
      case 'TASK_DETAIL_SYNCED':
        this.applyTaskLifecycleStatus(event.taskStatus, event.updatedAt)
        break

      case 'LEAVE': {
        const runtime: TaskRuntimeState = {
          taskId: this.state.taskId,
          phase: 'unknown',
          joinedRoom: false,
          localStreamCursor: 0,
        }
        this.state = {
          ...this.state,
          status: 'idle',
          messages: new Map(),
          error: null,
          isStopping: false,
          runtime,
          derived: this.deriveRuntimeState(runtime),
        }
        this.pendingRecovery = false
        this.pendingRecoveryReason = undefined
        this.pendingRecoveryOptions = undefined
        this.pendingChunks = [] // Clear pending chunks queue on leave
        break
      }
    }

    this.notifyListeners()

    // Process queued recovery after reaching ready/streaming/error state
    if (
      this.pendingRecovery &&
      (this.state.status === 'ready' ||
        this.state.status === 'streaming' ||
        this.state.status === 'error')
    ) {
      const recoveryReason = this.pendingRecoveryReason
      const recoveryOptions = this.pendingRecoveryOptions
      this.pendingRecovery = false
      this.pendingRecoveryReason = undefined
      this.pendingRecoveryOptions = undefined
      await this.recover({ force: true, reason: recoveryReason, ...recoveryOptions })
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
      this.pendingRecoveryReason = event.reason
      this.pendingRecoveryOptions = {
        resumeFromCursor: event.resumeFromCursor,
        activeStreamSubtaskId: event.activeStreamSubtaskId,
        syncAfterMessageId: event.syncAfterMessageId,
      }
      return
    }

    // Check WebSocket connection before consuming the recovery debounce window.
    // A recovery scheduled during a connection-state race must be able to retry
    // immediately once the socket is actually available.
    if (!this.deps.isConnected()) {
      this.pendingRecovery = true
      this.pendingRecoveryReason = event.reason
      this.pendingRecoveryOptions = {
        resumeFromCursor: event.resumeFromCursor,
        activeStreamSubtaskId: event.activeStreamSubtaskId,
        syncAfterMessageId: event.syncAfterMessageId,
      }

      const runtime: TaskRuntimeState = {
        ...this.state.runtime,
        phase: 'syncing',
        recoveryReason: event.reason,
        recoveryError: 'socket-disconnected',
      }
      this.state = {
        ...this.state,
        status: 'waiting_socket',
        error: null,
        runtime,
        derived: this.deriveRuntimeState(runtime),
      }
      this.notifyListeners()
      return
    }

    // Debounce check
    const now = Date.now()
    if (!event.force && now - this.lastRecoveryTime < this.recoveryDebounceMs) {
      return
    }
    this.lastRecoveryTime = now
    this.pendingRecovery = false
    this.pendingRecoveryReason = undefined
    this.pendingRecoveryOptions = undefined
    const recoveryVersion = ++this.recoveryVersion

    // Transition to joining
    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      phase: 'syncing',
      recoveryReason: event.reason,
      recoveryError: undefined,
    }
    this.state = {
      ...this.state,
      status: 'joining',
      error: null,
      runtime,
      derived: this.deriveRuntimeState(runtime),
    }
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

      // Join WebSocket room and get stream recovery + subtasks
      // Pass afterMessageId for incremental sync on reconnect
      const joinOptions: {
        forceRefresh: boolean
        afterMessageId?: number
        resumeFromCursor?: number
        activeStreamSubtaskId?: number
      } = {
        forceRefresh: true,
        afterMessageId: event.syncAfterMessageId ?? maxMessageId,
      }
      if (event.resumeFromCursor !== undefined) {
        joinOptions.resumeFromCursor = event.resumeFromCursor
      }
      if (event.activeStreamSubtaskId !== undefined) {
        joinOptions.activeStreamSubtaskId = event.activeStreamSubtaskId
      }

      const response = await this.deps.joinTask(this.state.taskId, joinOptions)
      if (this.closed || recoveryVersion !== this.recoveryVersion) {
        this.deps.leaveTask?.(this.state.taskId)
        return
      }

      if (response.error) {
        await this.dispatch({ type: 'JOIN_FAILURE', error: response.error })
        return
      }

      // Pass subtasks to JOIN_SUCCESS event for immediate sync
      const subtasks = response.subtasks as TaskDetailSubtask[] | undefined
      const messageIds = Array.isArray(subtasks)
        ? subtasks
            .map(subtask => subtask.message_id)
            .filter((messageId): messageId is number => typeof messageId === 'number')
        : []

      console.info('[TaskStateMachine] recover join ack', {
        taskId: this.state.taskId,
        maxMessageId,
        messagesBeforeSync: this.state.messages.size,
        subtasksCount: Array.isArray(subtasks) ? subtasks.length : null,
        firstMessageId: messageIds[0],
        lastMessageId: messageIds[messageIds.length - 1],
        hasStreaming: Boolean(response.streaming),
        streamRecoverySubtaskId: response.streaming?.subtask_id,
      })

      await this.dispatch({
        type: 'JOIN_SUCCESS',
        streamRecovery: response.streaming,
        subtasks,
        syncUpdatedAt: event.syncUpdatedAt ?? this.state.runtime.lastStatusUpdatedAt,
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      await this.dispatch({ type: 'JOIN_FAILURE', error: errorMsg })
    }
  }

  /**
   * Sync messages from backend subtasks
   */
  private async doSync(
    subtasks?: TaskDetailSubtask[],
    syncUpdatedAt?: string,
    streamRecovery?: StreamingRecoveryPayload
  ): Promise<void> {
    try {
      if (subtasks && subtasks.length > 0) {
        const messagesBefore = this.state.messages.size
        this.buildMessages(subtasks, streamRecovery)
        console.info('[TaskStateMachine] sync subtasks', {
          taskId: this.state.taskId,
          subtasksCount: subtasks.length,
          messagesBefore,
          messagesAfter: this.state.messages.size,
          status: this.state.status,
        })
      }

      // CRITICAL: If stream recovery data exists but no streaming message was created,
      // create one now. This handles the case where:
      // 1. User joins room while streaming is in progress
      // 2. Backend returns stream recovery with subtask_id and cached_content
      // 3. But subtasks array doesn't contain this subtask yet (race condition)
      // Without this, subsequent CHAT_CHUNK events would be ignored
      if (streamRecovery && streamRecovery.subtask_id) {
        const aiMessageId = generateMessageId('ai', streamRecovery.subtask_id)
        const existingMessage = this.state.messages.get(aiMessageId)

        // Create message if it doesn't exist
        if (!existingMessage) {
          const newMessages = new Map(this.state.messages)
          newMessages.set(aiMessageId, {
            id: aiMessageId,
            type: 'ai',
            status: 'streaming',
            content: streamRecovery.cached_content || '',
            timestamp: Date.now(),
            subtaskId: streamRecovery.subtask_id,
            // Include blocks from Redis for page refresh recovery
            // This preserves tool-text-tool-text order during streaming
            result: streamRecovery.blocks?.length ? { blocks: streamRecovery.blocks } : undefined,
          })
          this.state = { ...this.state, messages: newMessages }
        } else if (existingMessage.status === 'streaming') {
          // Update existing message with Redis data if it has more recent content or blocks
          const shouldUpdateContent =
            streamRecovery.cached_content &&
            streamRecovery.cached_content.length > existingMessage.content.length
          const shouldUpdateBlocks =
            streamRecovery.blocks?.length &&
            (!existingMessage.result?.blocks ||
              streamRecovery.blocks.length > existingMessage.result.blocks.length)

          if (shouldUpdateContent || shouldUpdateBlocks) {
            const newMessages = new Map(this.state.messages)
            const updatedMessage: UnifiedMessage = { ...existingMessage }

            if (shouldUpdateContent) {
              updatedMessage.content = streamRecovery.cached_content!
            }

            if (shouldUpdateBlocks) {
              updatedMessage.result = {
                ...existingMessage.result,
                blocks: streamRecovery.blocks,
              }
            }

            newMessages.set(aiMessageId, updatedMessage)
            this.state = { ...this.state, messages: newMessages }
          }
        }
      }

      // Check if any message is streaming
      let activeStreamSubtaskId: number | null = null
      for (const msg of this.state.messages.values()) {
        if (msg.type === 'ai' && msg.status === 'streaming') {
          activeStreamSubtaskId = msg.subtaskId || null
          break
        }
      }

      if (activeStreamSubtaskId) {
        const isRecoveredStream = streamRecovery?.subtask_id === activeStreamSubtaskId
        await this.dispatch({
          type: 'SYNC_DONE_STREAMING',
          subtaskId: activeStreamSubtaskId,
          cursor: isRecoveredStream
            ? (streamRecovery.offset ?? streamRecovery.cached_content?.length ?? 0)
            : 0,
          startedAt: isRecoveredStream ? streamRecovery.started_at : undefined,
          lastActivityAt: isRecoveredStream ? streamRecovery.last_activity_at : undefined,
          syncUpdatedAt,
        })
      } else {
        await this.dispatch({ type: 'SYNC_DONE', syncUpdatedAt })
      }

      // Apply pending chunks that were queued during sync
      // This ensures chunks received during joining/syncing are not lost
      this.applyPendingChunks()
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Sync failed'
      console.error('[TaskStateMachine] sync failed', {
        taskId: this.state.taskId,
        subtasksCount: subtasks?.length ?? null,
        error,
      })
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
      const contentMerge = mergeChunkContent(existingMessage.content, chunk.content, chunk.offset)
      const newMessages = new Map(this.state.messages)
      const updatedMessage: UnifiedMessage = {
        ...existingMessage,
        content: contentMerge.content,
      }

      // Handle reasoning content
      if (chunk.result?.reasoning_chunk) {
        updatedMessage.reasoningContent =
          (existingMessage.reasoningContent || '') + chunk.result.reasoning_chunk
        updatedMessage.isReasoningStreaming = true
      } else if (chunk.result?.reasoning_content) {
        updatedMessage.reasoningContent = chunk.result.reasoning_content
      }

      // When normal content arrives, reasoning phase is over
      if (chunk.content) {
        updatedMessage.isReasoningStreaming = false
      }

      // Handle blocks
      // CRITICAL: Always call mergeBlocksFromPendingChunk and update result.blocks
      // This ensures text blocks are created for ClaudeCode executor
      // which sends chat:chunk without block_id or result
      const mergedBlocks = this.mergeBlocksFromPendingChunk(
        existingMessage,
        chunk,
        contentMerge.appendedContent
      )

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
      } else {
        // CRITICAL FIX: Always update blocks even when no chunk.result
        // This handles ClaudeCode executor which sends text content without block_id
        // The mergeBlocksFromPendingChunk method will create text blocks to maintain chronological order
        updatedMessage.result = {
          ...existingMessage.result,
          blocks: mergedBlocks,
        }
      }
      if (chunk.sources) {
        updatedMessage.sources = chunk.sources
      }

      newMessages.set(aiMessageId, updatedMessage)
      const runtime: TaskRuntimeState = {
        ...this.state.runtime,
        phase: 'streaming',
        activeStreamSubtaskId: chunk.subtaskId,
        localStreamCursor: updatedMessage.content.length,
        localLastChunkAt: Date.now(),
      }
      this.state = {
        ...this.state,
        messages: newMessages,
        runtime,
        derived: this.deriveRuntimeState(runtime),
      }
    }

    // Clear the pending chunks queue
    this.pendingChunks = []
    this.notifyListeners()
  }

  /**
   * Merge blocks for pending chunk (similar to mergeBlocks but for PendingChunkEvent)
   *
   * Handles five cases:
   * 1. Reasoning chunk: create/update a thinking block
   * 2. Text block streaming with blockId: blockId + content -> append content to existing text block
   * 3. Text content without blockId: create/update a text block to maintain chronological order
   * 4. No incoming blocks and no content: keep existing blocks unchanged
   * 5. Tool/other blocks: merge by block.id, preserving existing fields for partial updates
   *
   * CRITICAL: For ClaudeCode executor, text content arrives via chat:chunk without block_id.
   * We need to create text blocks on-the-fly to maintain tool-text-tool-text order.
   */
  private mergeBlocksFromPendingChunk(
    existingMessage: UnifiedMessage,
    chunk: PendingChunkEvent,
    appendedContent: string
  ): MessageBlock[] {
    return mergeStreamingBlocks({
      existingBlocks: existingMessage.result?.blocks || [],
      incomingBlocks: chunk.result?.blocks || [],
      content: appendedContent,
      blockId: chunk.blockId,
      reasoningChunk: chunk.result?.reasoning_chunk,
    })
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
  private buildMessages(
    subtasks: TaskDetailSubtask[],
    streamRecovery?: StreamingRecoveryPayload
  ): void {
    const { teamName, isGroupChat, currentUserId, currentUserName, forceClean } = this.syncOptions

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
      const subtaskResult = subtask.result as UnifiedMessage['result']

      // Handle RUNNING AI messages with content priority
      // IMPORTANT: Always process RUNNING AI messages even if they already exist
      // This ensures Redis cached_content and better existing content are used
      if (!isUserMessage && subtask.status === 'RUNNING') {
        const existingAiMessage = messages.get(messageId)
        const backendContent = typeof subtaskResult?.value === 'string' ? subtaskResult.value : ''

        // Content priority: Redis > existing > backend
        let bestContent = backendContent

        // Check existing message content
        if (existingAiMessage && existingAiMessage.content.length > bestContent.length) {
          bestContent = existingAiMessage.content
        }

        // Check Redis cached content
        if (
          streamRecovery &&
          streamRecovery.subtask_id === subtask.id &&
          streamRecovery.cached_content &&
          streamRecovery.cached_content.length > bestContent.length
        ) {
          bestContent = streamRecovery.cached_content
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
          result: subtaskResult,
          error: hasFrontendError ? existingMessage?.error : undefined,
          errorType: hasFrontendError ? existingMessage?.errorType : undefined,
          // Preserve existing reasoning content if present
          reasoningContent: existingAiMessage?.reasoningContent,
        })
        continue
      }

      // Skip PENDING AI messages
      if (!isUserMessage && subtask.status === 'PENDING') {
        continue
      }

      const existingSnapshotMessage = messages.get(messageId)
      if (existingSnapshotMessage && !isUserMessage) {
        const backendContent = typeof subtaskResult?.value === 'string' ? subtaskResult.value : ''
        const nextStatus: MessageStatus =
          subtask.status === 'FAILED' || subtask.status === 'CANCELLED' || hasFrontendError
            ? 'error'
            : 'completed'

        messages.set(messageId, {
          ...existingSnapshotMessage,
          status: nextStatus,
          content:
            backendContent.length > existingSnapshotMessage.content.length
              ? backendContent
              : existingSnapshotMessage.content,
          messageId: subtask.message_id,
          subtaskStatus: subtask.status,
          result: subtaskResult,
          error: hasFrontendError ? existingMessage?.error : subtask.error_message || undefined,
          errorType: hasFrontendError
            ? existingMessage?.errorType
            : ((subtaskResult as Record<string, unknown>)?.error_type as string | undefined),
          isReasoningStreaming: false,
        })
        continue
      }

      // Skip if already exists by subtaskId (for non-RUNNING messages)
      if (existingSubtaskIds.has(subtask.id)) {
        continue
      }

      // Skip if already exists by message ID (for user messages)
      if (messages.has(messageId)) {
        continue
      }

      // Skip USER messages if we already have enough
      if (isUserMessage && existingUserMessageCount >= incomingUserSubtasks.length) {
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
        : typeof subtaskResult?.value === 'string'
          ? subtaskResult.value
          : ''

      const errorField = hasFrontendError
        ? existingMessage?.error
        : subtask.error_message || undefined

      // Recover error_type from result JSON (set by backend on FAILED subtasks)
      const errorTypeField = hasFrontendError
        ? existingMessage?.errorType
        : ((subtaskResult as Record<string, unknown>)?.error_type as string | undefined)

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
        result: subtaskResult,
        error: errorField,
        errorType: errorTypeField,
      })
    }

    this.state = { ...this.state, messages }
  }

  /**
   * Handle CHAT_START event
   */
  private handleChatStartEvent(event: Extract<Event, { type: 'CHAT_START' }>): void {
    const aiMessageId = generateMessageId('ai', event.subtaskId)
    const existingMessage = this.state.messages.get(aiMessageId)
    const isRestartingAfterTerminal =
      isTerminalTaskStatus(this.state.runtime.taskStatus) && !existingMessage

    if (isTerminalTaskStatus(this.state.runtime.taskStatus) && existingMessage) return

    const initialResult = event.shellType ? { shell_type: event.shellType } : undefined

    const newMessages = new Map(this.state.messages)
    newMessages.set(aiMessageId, {
      id: aiMessageId,
      type: 'ai',
      status: 'streaming',
      content: '',
      timestamp: Date.now(),
      subtaskId: event.subtaskId,
      messageId: event.messageId, // Set messageId from chat:start event for proper ordering
      result: initialResult,
    })
    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      taskStatus: isRestartingAfterTerminal ? 'RUNNING' : this.state.runtime.taskStatus,
      phase: 'streaming',
      activeStreamSubtaskId: event.subtaskId,
      activeStreamStartedAt: new Date().toISOString(),
      activeStreamLastActivityAt: undefined,
      localStreamCursor: 0,
      localLastChunkAt: Date.now(),
    }

    this.state = {
      ...this.state,
      status: 'streaming',
      messages: newMessages,
      runtime,
      derived: this.deriveRuntimeState(runtime),
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

    // If in idle/joining/syncing state, queue the chunk for later processing
    // This handles the race condition where chunks arrive before sync completes
    // CRITICAL FIX: Also queue chunks when in 'idle' state, because after page refresh,
    // WebSocket reconnects and starts receiving chunks before recover() is called
    if (
      this.state.status === 'idle' ||
      this.state.status === 'joining' ||
      this.state.status === 'syncing'
    ) {
      this.pendingChunks.push({
        subtaskId: event.subtaskId,
        content: event.content,
        offset: event.offset,
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

    const contentMerge = mergeChunkContent(existingMessage.content, event.content, event.offset)
    const newMessages = new Map(this.state.messages)
    const updatedMessage: UnifiedMessage = {
      ...existingMessage,
      content: contentMerge.content,
    }

    // Handle reasoning content
    if (event.result?.reasoning_chunk) {
      updatedMessage.reasoningContent =
        (existingMessage.reasoningContent || '') + event.result.reasoning_chunk
      updatedMessage.isReasoningStreaming = true
    } else if (event.result?.reasoning_content) {
      updatedMessage.reasoningContent = event.result.reasoning_content
    }

    // When normal content arrives, reasoning phase is over
    if (event.content) {
      updatedMessage.isReasoningStreaming = false
    }

    // Handle blocks
    // CRITICAL: Always call mergeBlocks and update result.blocks
    // This ensures text blocks are created for ClaudeCode executor
    // which sends chat:chunk without block_id or result
    const mergedBlocks = this.mergeBlocks(existingMessage, event, contentMerge.appendedContent)

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
    } else {
      // CRITICAL FIX: Always update blocks even when no event.result
      // This handles ClaudeCode executor which sends text content without block_id
      // The mergeBlocks method will create text blocks to maintain chronological order
      updatedMessage.result = {
        ...existingMessage.result,
        blocks: mergedBlocks,
      }
    }

    if (event.sources) {
      updatedMessage.sources = event.sources
    }

    newMessages.set(aiMessageId, updatedMessage)
    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      phase: 'streaming',
      activeStreamSubtaskId: event.subtaskId,
      localStreamCursor: updatedMessage.content.length,
      localLastChunkAt: Date.now(),
    }
    this.state = {
      ...this.state,
      messages: newMessages,
      runtime,
      derived: this.deriveRuntimeState(runtime),
    }

    // CRITICAL: Notify listeners after updating state
    // Without this, UI won't update when receiving chunks
    this.notifyListeners()
  }

  /**
   * Merge blocks for incremental updates
   *
   * Handles five cases:
   * 1. Reasoning chunk: create/update a thinking block
   * 2. Text block streaming with blockId: blockId + content -> append content to existing text block
   * 3. Text content without blockId: create/update a text block to maintain chronological order
   * 4. No incoming blocks and no content: keep existing blocks unchanged
   * 5. Tool/other blocks: merge by block.id, preserving existing fields for partial updates
   *
   * CRITICAL: For ClaudeCode executor, text content arrives via chat:chunk without block_id.
   * We need to create text blocks on-the-fly to maintain tool-text-tool-text order.
   */
  private mergeBlocks(
    existingMessage: UnifiedMessage,
    event: Extract<Event, { type: 'CHAT_CHUNK' }>,
    appendedContent: string
  ): MessageBlock[] {
    return mergeStreamingBlocks({
      existingBlocks: existingMessage.result?.blocks || [],
      incomingBlocks: event.result?.blocks || [],
      content: appendedContent,
      blockId: event.blockId,
      reasoningChunk: event.result?.reasoning_chunk,
    })
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

    const isActiveStreamEvent =
      this.state.status === 'streaming' &&
      this.state.runtime.activeStreamSubtaskId === event.subtaskId
    if (
      !isActiveStreamEvent &&
      (existingMessage.status === 'error' ||
        existingMessage.subtaskStatus === 'FAILED' ||
        existingMessage.subtaskStatus === 'CANCELLED')
    ) {
      return
    }
    if (!isActiveStreamEvent && existingMessage.status === 'completed' && event.hasError) return

    const terminalTaskStatus =
      isActiveStreamEvent && this.state.runtime.deferredTerminalStatus
        ? this.state.runtime.deferredTerminalStatus
        : isActiveStreamEvent
          ? event.hasError
            ? 'FAILED'
            : 'COMPLETED'
          : this.state.runtime.taskStatus
    const hasTerminalLifecycle = isTerminalTaskStatus(terminalTaskStatus)
    const finalStatus: MessageStatus = hasTerminalLifecycle
      ? terminalTaskStatus === 'FAILED' || terminalTaskStatus === 'CANCELLED'
        ? 'error'
        : 'completed'
      : event.hasError
        ? 'error'
        : 'completed'
    const finalSubtaskStatus = hasTerminalLifecycle
      ? terminalTaskStatus === 'FAILED' || terminalTaskStatus === 'CANCELLED'
        ? terminalTaskStatus
        : 'COMPLETED'
      : event.hasError
        ? 'FAILED'
        : 'COMPLETED'

    // CRITICAL FIX: Preserve accumulated content from streaming
    // Only use event.content if existingMessage.content is empty
    // This prevents losing mixed content (tool-text-tool-text) when chat:done arrives
    // because event.content (result.value) may only contain the final text segment
    const incomingContent =
      !hasTerminalLifecycle || terminalTaskStatus === 'COMPLETED'
        ? event.content || (typeof event.result?.value === 'string' ? event.result.value : '')
        : ''
    const finalContent =
      incomingContent.length > existingMessage.content.length
        ? incomingContent
        : existingMessage.content || incomingContent

    // CRITICAL FIX: Merge blocks instead of replacing
    // Preserve blocks accumulated during streaming (tool blocks and text blocks)
    // event.result.blocks may be incomplete or only contain final state
    const mergedBlocks = mergeBlocksForDone(
      existingMessage.result?.blocks || [],
      event.result?.blocks || []
    )
    const mergedResult =
      event.result || existingMessage.result?.blocks
        ? {
            ...existingMessage.result,
            ...(event.result || {}),
            thinking: event.result?.thinking || existingMessage.result?.thinking,
            blocks: mergedBlocks,
          }
        : existingMessage.result

    const newMessages = new Map(this.state.messages)
    newMessages.set(aiMessageId, {
      ...existingMessage,
      status: finalStatus,
      subtaskStatus: finalSubtaskStatus,
      content: finalContent,
      timestamp: event.hasError ? Date.now() : existingMessage.timestamp,
      isReasoningStreaming: false,
      error: event.hasError ? event.errorMessage : existingMessage.error,
      // CRITICAL FIX: Only update messageId if event.messageId is defined
      // Otherwise preserve the existing messageId from chat:start
      // This prevents messageId from being overwritten with undefined/null
      messageId: event.messageId ?? existingMessage.messageId,
      sources: event.sources || existingMessage.sources,
      result: mergedResult,
    })

    // Update status to ready if this was the streaming subtask
    const newStatus = isActiveStreamEvent ? 'ready' : this.state.status
    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      taskStatus: isActiveStreamEvent ? terminalTaskStatus : this.state.runtime.taskStatus,
      phase: isActiveStreamEvent
        ? getRuntimePhaseForTaskStatus(terminalTaskStatus, false)
        : this.state.runtime.phase,
      activeStreamSubtaskId: isActiveStreamEvent
        ? undefined
        : this.state.runtime.activeStreamSubtaskId,
      activeStreamStartedAt: isActiveStreamEvent
        ? undefined
        : this.state.runtime.activeStreamStartedAt,
      activeStreamLastActivityAt: isActiveStreamEvent
        ? undefined
        : this.state.runtime.activeStreamLastActivityAt,
      localStreamCursor: isActiveStreamEvent ? 0 : this.state.runtime.localStreamCursor,
      lastStatusUpdatedAt: isActiveStreamEvent
        ? (this.state.runtime.deferredTerminalUpdatedAt ?? this.state.runtime.lastStatusUpdatedAt)
        : this.state.runtime.lastStatusUpdatedAt,
      lastTerminalStatusUpdatedAt: isActiveStreamEvent
        ? (this.state.runtime.deferredTerminalUpdatedAt ??
          this.state.runtime.lastTerminalStatusUpdatedAt)
        : this.state.runtime.lastTerminalStatusUpdatedAt,
      hasTerminalStatus: isActiveStreamEvent ? true : this.state.runtime.hasTerminalStatus,
      deferredTerminalStatus: isActiveStreamEvent
        ? undefined
        : this.state.runtime.deferredTerminalStatus,
      deferredTerminalUpdatedAt: isActiveStreamEvent
        ? undefined
        : this.state.runtime.deferredTerminalUpdatedAt,
    }

    this.state = {
      ...this.state,
      status: newStatus,
      messages: newMessages,
      isStopping: isActiveStreamEvent ? false : this.state.isStopping,
      runtime,
      derived: this.deriveRuntimeState(runtime),
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

    if (isTerminalTaskStatus(this.state.runtime.taskStatus)) return
    const isActiveStreamEvent =
      this.state.status === 'streaming' &&
      this.state.runtime.activeStreamSubtaskId === event.subtaskId
    if (!isActiveStreamEvent) return

    const newMessages = new Map(this.state.messages)
    newMessages.set(aiMessageId, {
      ...existingMessage,
      status: 'error',
      subtaskStatus: 'FAILED',
      timestamp: Date.now(),
      error: event.error,
      errorType: event.errorType ?? existingMessage.errorType,
      messageId: event.messageId ?? existingMessage.messageId,
    })

    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      taskStatus: 'FAILED',
      phase: 'terminal',
      activeStreamSubtaskId: undefined,
      activeStreamStartedAt: undefined,
      activeStreamLastActivityAt: undefined,
      localStreamCursor: 0,
      hasTerminalStatus: true,
      deferredTerminalStatus: undefined,
      deferredTerminalUpdatedAt: undefined,
    }

    this.state = {
      ...this.state,
      status: 'error',
      messages: newMessages,
      error: event.error,
      isStopping: false,
      runtime,
      derived: this.deriveRuntimeState(runtime),
    }
  }

  /**
   * Handle CHAT_CANCELLED event
   */
  private handleChatCancelledEvent(event: Extract<Event, { type: 'CHAT_CANCELLED' }>): void {
    const aiMessageId = generateMessageId('ai', event.subtaskId)
    const existingMessage = this.state.messages.get(aiMessageId)

    if (!existingMessage) return
    if (isTerminalTaskStatus(this.state.runtime.taskStatus)) return

    const newMessages = new Map(this.state.messages)
    newMessages.set(aiMessageId, {
      ...existingMessage,
      status: 'completed',
      subtaskStatus: 'CANCELLED',
    })

    const newStatus =
      this.state.status === 'streaming' &&
      this.state.runtime.activeStreamSubtaskId === event.subtaskId
        ? 'ready'
        : this.state.status
    if (newStatus === this.state.status) return

    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      taskStatus: 'CANCELLED',
      phase: 'terminal',
      activeStreamSubtaskId: undefined,
      activeStreamStartedAt: undefined,
      activeStreamLastActivityAt: undefined,
      localStreamCursor: 0,
      hasTerminalStatus: true,
      deferredTerminalStatus: undefined,
      deferredTerminalUpdatedAt: undefined,
    }

    this.state = {
      ...this.state,
      status: newStatus,
      messages: newMessages,
      isStopping: false,
      runtime,
      derived: this.deriveRuntimeState(runtime),
    }
  }

  private handleSendAcceptedEvent(event: Extract<Event, { type: 'SEND_ACCEPTED' }>): void {
    const activeStreamSubtaskId = this.state.runtime.activeStreamSubtaskId
    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      taskId: this.state.taskId,
      taskStatus: 'RUNNING',
      phase: getRuntimePhaseForTaskStatus('RUNNING', Boolean(activeStreamSubtaskId)),
      activeStreamSubtaskId,
      lastStatusUpdatedAt: event.acceptedAt,
      lastTerminalStatusUpdatedAt: undefined,
      hasTerminalStatus: false,
      deferredTerminalStatus: undefined,
      deferredTerminalUpdatedAt: undefined,
    }

    this.state = {
      ...this.state,
      status: activeStreamSubtaskId === undefined ? 'ready' : 'streaming',
      error: null,
      isStopping: false,
      runtime,
      derived: this.deriveRuntimeState(runtime),
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
