// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * TaskStateMachine
 *
 * Single source of truth for task messages, runtime state, and recovery.
 */

import type { TaskDetail, TaskDetailSubtask, TaskStatus as ApiTaskStatus } from '../api-types'
import {
  reduceChatCancelledEvent,
  reduceChatChunkEvent,
  reduceChatDoneEvent,
  reduceChatErrorEvent,
  reduceChatStartEvent,
  reduceSendAcceptedEvent,
} from './TaskStateMachine.chatEvents'
import { applyTaskLifecycleStatusToState } from './TaskStateMachine.lifecycle'
import { generateMessageId } from './TaskStateMachine.messageUtils'
import { applyPendingChunksToState } from './TaskStateMachine.pendingChunks'
import { buildRecoverJoinOptions, logRecoverJoinAck } from './TaskStateMachine.recovery'
import { RuntimeStabilityProbe } from './TaskStateMachine.runtimeProbe'
import {
  finalizeStaleStreamingMessagesForNoStream,
  type SyncCompletionEvent,
  syncMessagesFromJoinPayload,
} from './TaskStateMachine.sync'
import type {
  Event,
  PendingChunkEvent,
  StateListener,
  StreamingRecoveryPayload,
  SyncOptions,
  TaskMachineInternalState,
  TaskRecoveryReason,
  TaskRuntimeDerivedState,
  TaskRuntimeState,
  TaskRuntimeVerifyResult,
  TaskStateMachineDeps,
  TaskStateSnapshot,
  UnifiedMessage,
} from './TaskStateMachine.types'
import {
  getRuntimePhaseForTaskStatus,
  isActiveExecutionTaskStatus,
  isTerminalTaskStatus,
  isWaitingForUserTaskStatus,
} from './taskStatusClassifier'

const RUNTIME_CONSISTENCY_GRACE_MS = 3000

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
  private runtimeStabilityProbe: RuntimeStabilityProbe
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
    this.runtimeStabilityProbe = new RuntimeStabilityProbe(
      reason => this.checkHealth(reason),
      () => this.syncRuntimeStabilityProbe(),
      () => this.closed
    )
  }

  updateDeps(deps: TaskStateMachineDeps): void {
    this.deps = deps
  }

  refreshRuntimeProbe(): void {
    this.syncRuntimeStabilityProbe()
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
    const hasActiveStream = runtime.phase === 'streaming' && Boolean(runtime.activeStreamSubtaskId)

    const serverConfirmedNoStream = Boolean(runtime.serverConfirmedNoStream)
    const isStreaming =
      hasActiveStream || (runtime.taskStatus === 'RUNNING' && !serverConfirmedNoStream)

    return {
      isExecutionActive,
      isTerminal,
      isStreaming,
      shouldJoinRoom: isExecutionActive && !runtime.joinedRoom,
      canSendMessage:
        isTerminal || isWaitingForUser || (runtime.phase === 'running' && serverConfirmedNoStream),
      canQueueMessage: hasActiveStream,
      canCancelTask: isExecutionActive && !isTerminal && !serverConfirmedNoStream,
      blocksQueuedDispatch: isExecutionActive && !serverConfirmedNoStream,
      serverConfirmedNoStream,
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
    this.runtimeStabilityProbe.stop()
    this.deps.leaveTask?.(this.state.taskId)
    this.leave()
  }

  loadTask(taskDetail: Pick<TaskDetail, 'id' | 'status' | 'updated_at'>): void {
    if (taskDetail.id !== this.state.taskId) return
    this.applyTaskLifecycleStatus(taskDetail.status, taskDetail.updated_at)
    this.notifyListeners()
  }

  private async checkHealth(reason: TaskRecoveryReason): Promise<void> {
    if (!this.deps.isConnected()) return
    if (!this.deps.pullRuntime) {
      throw new Error('[TaskStateMachine] pullRuntime action is required for checkHealth().')
    }

    const server = await this.deps.pullRuntime(this.state.taskId)
    if (!server) return
    await this.reconcileRuntime(server, reason)
  }

  async requestRuntimeCheck(reason: TaskRecoveryReason): Promise<void> {
    if (this.closed || !this.deps.isConnected() || !this.deps.pullRuntime) {
      this.syncRuntimeStabilityProbe()
      return
    }

    await this.runtimeStabilityProbe.runNow(reason)
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

    if (!server.active_stream && isActiveExecutionTaskStatus(server.task_status)) {
      this.state = finalizeStaleStreamingMessagesForNoStream(this.state)
      this.clearLocalStream({ serverConfirmedNoStream: true })
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

  private clearLocalStream(options?: { serverConfirmedNoStream?: boolean }): void {
    const serverConfirmedNoStream =
      options?.serverConfirmedNoStream ?? this.state.runtime.serverConfirmedNoStream
    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      phase: getRuntimePhaseForTaskStatus(this.state.runtime.taskStatus, false),
      activeStreamSubtaskId: undefined,
      activeStreamStartedAt: undefined,
      activeStreamLastActivityAt: undefined,
      localStreamCursor: 0,
      serverConfirmedNoStream,
    }
    this.state = {
      ...this.state,
      status: 'ready',
      isStopping: false,
      runtime,
      derived: this.deriveRuntimeState(runtime),
    }
  }

  private applyTaskLifecycleStatus(taskStatus: ApiTaskStatus, updatedAt?: string): void {
    const result = applyTaskLifecycleStatusToState({
      state: this.state,
      taskStatus,
      updatedAt,
      deriveRuntimeState: runtime => this.deriveRuntimeState(runtime),
    })
    this.state = result.state
    if (result.clearPendingChunks) {
      this.pendingChunks = []
    }
  }

  private shouldProbeRuntimeInstability(): boolean {
    const waitingForStream =
      this.state.runtime.taskStatus === 'RUNNING' &&
      this.state.runtime.activeStreamSubtaskId === undefined &&
      !this.state.runtime.serverConfirmedNoStream
    const cancelPending =
      this.state.isStopping &&
      this.state.runtime.activeStreamSubtaskId !== undefined &&
      !isTerminalTaskStatus(this.state.runtime.taskStatus)

    return !this.isRecoveryStatus() && (waitingForStream || cancelPending)
  }

  private syncRuntimeStabilityProbe(): void {
    if (this.closed || !this.deps.pullRuntime || !this.deps.isConnected()) {
      this.runtimeStabilityProbe.stop()
      return
    }

    if (this.shouldProbeRuntimeInstability()) {
      this.runtimeStabilityProbe.schedule('runtime-instability-probe', RUNTIME_CONSISTENCY_GRACE_MS)
      return
    }

    this.runtimeStabilityProbe.stop()
  }

  private isRecoveryStatus(): boolean {
    return (
      this.state.status === 'waiting_socket' ||
      this.state.status === 'joining' ||
      this.state.status === 'syncing'
    )
  }

  private enterWaitingSocket(reason?: TaskRecoveryReason): void {
    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      phase: 'syncing',
      recoveryReason: reason,
      recoveryError: 'socket-disconnected',
    }
    this.state = {
      ...this.state,
      status: 'waiting_socket',
      error: null,
      runtime,
      derived: this.deriveRuntimeState(runtime),
    }
  }

  private enterJoining(reason?: TaskRecoveryReason): void {
    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      phase: 'syncing',
      recoveryReason: reason,
      recoveryError: undefined,
    }
    this.state = {
      ...this.state,
      status: 'joining',
      error: null,
      runtime,
      derived: this.deriveRuntimeState(runtime),
    }
  }

  private enterSyncing(): void {
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
  }

  private enterRecoveryError(error: string): void {
    if (!this.isRecoveryStatus()) return

    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      recoveryError: error,
    }
    this.state = {
      ...this.state,
      status: 'error',
      error,
      runtime,
      derived: this.deriveRuntimeState(runtime),
    }
  }

  private applySyncCompletion(completion: SyncCompletionEvent): void {
    if (this.state.status !== 'syncing') return

    if (completion.type === 'done') {
      const runtime: TaskRuntimeState = {
        ...this.state.runtime,
        phase: getRuntimePhaseForTaskStatus(this.state.runtime.taskStatus, false),
        activeStreamSubtaskId: undefined,
        activeStreamStartedAt: undefined,
        activeStreamLastActivityAt: undefined,
        localStreamCursor: 0,
        lastSyncedAt: Date.now(),
        messagesSyncedUpdatedAt:
          completion.syncUpdatedAt ?? this.state.runtime.messagesSyncedUpdatedAt,
        serverConfirmedNoStream: true,
      }
      this.state = {
        ...this.state,
        status: 'ready',
        isStopping: false,
        runtime,
        derived: this.deriveRuntimeState(runtime),
      }
      return
    }

    const runtime: TaskRuntimeState = {
      ...this.state.runtime,
      phase: getRuntimePhaseForTaskStatus(this.state.runtime.taskStatus, true),
      activeStreamSubtaskId: completion.subtaskId,
      activeStreamStartedAt: completion.startedAt,
      activeStreamLastActivityAt: completion.lastActivityAt,
      localStreamCursor: completion.cursor,
      localLastChunkAt: Date.now(),
      lastSyncedAt: Date.now(),
      messagesSyncedUpdatedAt:
        completion.syncUpdatedAt ?? this.state.runtime.messagesSyncedUpdatedAt,
      serverConfirmedNoStream: false,
    }
    this.state = {
      ...this.state,
      status: 'streaming',
      isStopping: false,
      runtime,
      derived: this.deriveRuntimeState(runtime),
    }
  }

  /**
   * Dispatch an event to the state machine
   */
  private async dispatch(event: Event): Promise<void> {
    switch (event.type) {
      case 'RECOVER':
        await this.recoverToStableState(event)
        break

      case 'CHAT_START':
        this.state = reduceChatStartEvent({
          state: this.state,
          event,
          deriveRuntimeState: runtime => this.deriveRuntimeState(runtime),
        })
        break

      case 'CHAT_CHUNK': {
        const result = reduceChatChunkEvent({
          state: this.state,
          event,
          pendingChunks: this.pendingChunks,
          deriveRuntimeState: runtime => this.deriveRuntimeState(runtime),
        })
        this.state = result.state
        this.pendingChunks = result.pendingChunks
        if (result.notifyListenersImmediately) {
          this.notifyListeners()
        }
        break
      }

      case 'CHAT_DONE':
        this.state = reduceChatDoneEvent({
          state: this.state,
          event,
          deriveRuntimeState: runtime => this.deriveRuntimeState(runtime),
        })
        break

      case 'CHAT_ERROR':
        this.state = reduceChatErrorEvent({
          state: this.state,
          event,
          deriveRuntimeState: runtime => this.deriveRuntimeState(runtime),
        })
        break

      case 'CHAT_CANCELLED':
        this.state = reduceChatCancelledEvent({
          state: this.state,
          event,
          deriveRuntimeState: runtime => this.deriveRuntimeState(runtime),
        })
        break

      case 'SEND_ACCEPTED':
        this.state = reduceSendAcceptedEvent({
          state: this.state,
          event,
          deriveRuntimeState: runtime => this.deriveRuntimeState(runtime),
        })
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
   * Exceptional path: move any non-stable runtime state back to ready/streaming/error.
   */
  private async recoverToStableState(event: Extract<Event, { type: 'RECOVER' }>): Promise<void> {
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

      this.enterWaitingSocket(event.reason)
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

    this.enterJoining(event.reason)
    this.notifyListeners()

    try {
      const { joinOptions, maxMessageId } = buildRecoverJoinOptions(this.state, event)
      const response = await this.deps.joinTask(this.state.taskId, joinOptions)
      if (this.closed || recoveryVersion !== this.recoveryVersion) {
        this.deps.leaveTask?.(this.state.taskId)
        return
      }

      if (response.error) {
        this.enterRecoveryError(response.error)
        return
      }

      const subtasks = response.subtasks as TaskDetailSubtask[] | undefined
      logRecoverJoinAck({
        state: this.state,
        maxMessageId,
        subtasks,
        streaming: response.streaming,
      })

      this.enterSyncing()
      this.notifyListeners()
      await this.syncRecoveredMessages(
        subtasks,
        event.syncUpdatedAt ?? this.state.runtime.lastStatusUpdatedAt,
        response.streaming
      )
    } catch (error) {
      if (this.closed || recoveryVersion !== this.recoveryVersion) {
        return
      }
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      this.enterRecoveryError(errorMsg)
    }
  }

  /**
   * Sync messages from backend subtasks
   */
  private async syncRecoveredMessages(
    subtasks?: TaskDetailSubtask[],
    syncUpdatedAt?: string,
    streamRecovery?: StreamingRecoveryPayload
  ): Promise<void> {
    try {
      const result = syncMessagesFromJoinPayload({
        state: this.state,
        subtasks,
        syncOptions: this.syncOptions,
        syncUpdatedAt,
        streamRecovery,
      })
      this.state = result.state
      this.applySyncCompletion(result.completion)
      this.applyPendingChunks()
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Sync failed'
      console.error('[TaskStateMachine] sync failed', {
        taskId: this.state.taskId,
        subtasksCount: subtasks?.length ?? null,
        error,
      })
      this.enterRecoveryError(errorMsg)
    }
  }

  /**
   * Apply pending chunk events that were queued during sync
   */
  private applyPendingChunks(): void {
    const result = applyPendingChunksToState({
      state: this.state,
      pendingChunks: this.pendingChunks,
      deriveRuntimeState: runtime => this.deriveRuntimeState(runtime),
    })
    this.state = result.state
    this.pendingChunks = result.pendingChunks
    if (result.notifyListeners) {
      this.notifyListeners()
    }
  }

  /**
   * Notify all listeners of state change
   */
  private notifyListeners(): void {
    this.syncRuntimeStabilityProbe()
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
