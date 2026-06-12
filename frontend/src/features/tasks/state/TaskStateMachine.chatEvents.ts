// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { MessageBlock } from '../components/message/thinking/types'
import { mergeBlocksForDone, mergeStreamingBlocks } from './TaskStateMachine.blockMerging'
import { generateMessageId, mergeChunkContent } from './TaskStateMachine.messageUtils'
import type {
  Event,
  MessageStatus,
  PendingChunkEvent,
  TaskMachineInternalState,
  TaskRuntimeDerivedState,
  TaskRuntimeState,
  UnifiedMessage,
} from './TaskStateMachine.types'
import { getRuntimePhaseForTaskStatus, isTerminalTaskStatus } from './taskStatusClassifier'

type DeriveRuntimeState = (runtime: TaskRuntimeState) => TaskRuntimeDerivedState

interface ChatEventReducerParams<TEvent extends Event> {
  state: TaskMachineInternalState
  event: TEvent
  deriveRuntimeState: DeriveRuntimeState
}

interface ChatChunkReducerResult {
  state: TaskMachineInternalState
  pendingChunks: PendingChunkEvent[]
  notifyListenersImmediately: boolean
}

export function reduceChatStartEvent({
  state,
  event,
  deriveRuntimeState,
}: ChatEventReducerParams<Extract<Event, { type: 'CHAT_START' }>>): TaskMachineInternalState {
  const aiMessageId = generateMessageId('ai', event.subtaskId)
  const existingMessage = state.messages.get(aiMessageId)
  const isRestartingAfterTerminal =
    isTerminalTaskStatus(state.runtime.taskStatus) && !existingMessage

  if (isTerminalTaskStatus(state.runtime.taskStatus) && existingMessage) return state
  if (existingMessage && existingMessage.status !== 'streaming') return state

  const initialResult = event.shellType ? { shell_type: event.shellType } : undefined
  const newMessages = new Map(state.messages)
  newMessages.set(aiMessageId, {
    id: aiMessageId,
    type: 'ai',
    status: 'streaming',
    content: '',
    timestamp: Date.now(),
    subtaskId: event.subtaskId,
    messageId: event.messageId,
    result: initialResult,
  })

  const runtime: TaskRuntimeState = {
    ...state.runtime,
    taskStatus: isRestartingAfterTerminal ? 'RUNNING' : state.runtime.taskStatus,
    phase: 'streaming',
    activeStreamSubtaskId: event.subtaskId,
    activeStreamStartedAt: new Date().toISOString(),
    activeStreamLastActivityAt: undefined,
    localStreamCursor: 0,
    localLastChunkAt: Date.now(),
    serverConfirmedNoStream: false,
  }

  return {
    ...state,
    status: 'streaming',
    messages: newMessages,
    runtime,
    derived: deriveRuntimeState(runtime),
  }
}

export function reduceChatChunkEvent({
  state,
  event,
  pendingChunks,
  deriveRuntimeState,
}: ChatEventReducerParams<Extract<Event, { type: 'CHAT_CHUNK' }>> & {
  pendingChunks: PendingChunkEvent[]
}): ChatChunkReducerResult {
  if (state.status === 'idle' || state.status === 'joining' || state.status === 'syncing') {
    return {
      state,
      pendingChunks: [
        ...pendingChunks,
        {
          subtaskId: event.subtaskId,
          content: event.content,
          offset: event.offset,
          result: event.result,
          sources: event.sources,
          blockId: event.blockId,
        },
      ],
      notifyListenersImmediately: false,
    }
  }

  const aiMessageId = generateMessageId('ai', event.subtaskId)
  const existingMessage = state.messages.get(aiMessageId)

  if (!existingMessage) {
    console.warn(
      '[TaskStateMachine] CHAT_CHUNK ignored - message not found, waiting for chat:start',
      {
        subtaskId: event.subtaskId,
        taskId: state.taskId,
      }
    )
    return { state, pendingChunks, notifyListenersImmediately: false }
  }

  if (existingMessage.status !== 'streaming') {
    return { state, pendingChunks, notifyListenersImmediately: false }
  }

  const contentMerge = mergeChunkContent(existingMessage.content, event.content, event.offset)
  const newMessages = new Map(state.messages)
  const updatedMessage: UnifiedMessage = {
    ...existingMessage,
    content: contentMerge.content,
  }

  if (event.result?.reasoning_chunk) {
    updatedMessage.reasoningContent =
      (existingMessage.reasoningContent || '') + event.result.reasoning_chunk
    updatedMessage.isReasoningStreaming = true
  } else if (event.result?.reasoning_content) {
    updatedMessage.reasoningContent = event.result.reasoning_content
  }

  if (event.content) {
    updatedMessage.isReasoningStreaming = false
  }

  const mergedBlocks = mergeChunkBlocks(existingMessage, event, contentMerge.appendedContent)

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
    ...state.runtime,
    phase: 'streaming',
    activeStreamSubtaskId: event.subtaskId,
    localStreamCursor: updatedMessage.content.length,
    localLastChunkAt: Date.now(),
    serverConfirmedNoStream: false,
  }

  return {
    state: {
      ...state,
      messages: newMessages,
      runtime,
      derived: deriveRuntimeState(runtime),
    },
    pendingChunks,
    notifyListenersImmediately: true,
  }
}

export function reduceChatDoneEvent({
  state,
  event,
  deriveRuntimeState,
}: ChatEventReducerParams<Extract<Event, { type: 'CHAT_DONE' }>>): TaskMachineInternalState {
  const aiMessageId = generateMessageId('ai', event.subtaskId)
  let existingMessage = state.messages.get(aiMessageId)

  if (!existingMessage) {
    existingMessage = {
      id: aiMessageId,
      type: 'ai',
      status: 'streaming',
      content: event.content || (event.result?.value as string) || '',
      timestamp: Date.now(),
      subtaskId: event.subtaskId,
      result: event.result,
      sources: event.sources,
    }
  }

  const isActiveStreamEvent =
    state.status === 'streaming' && state.runtime.activeStreamSubtaskId === event.subtaskId

  if (
    !isActiveStreamEvent &&
    (existingMessage.status === 'error' ||
      existingMessage.subtaskStatus === 'FAILED' ||
      existingMessage.subtaskStatus === 'CANCELLED')
  ) {
    return state
  }
  if (!isActiveStreamEvent && existingMessage.status === 'completed' && event.hasError) return state

  const terminalTaskStatus =
    isActiveStreamEvent && state.runtime.deferredTerminalStatus
      ? state.runtime.deferredTerminalStatus
      : isActiveStreamEvent
        ? event.hasError
          ? 'FAILED'
          : 'COMPLETED'
        : state.runtime.taskStatus
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

  const incomingContent =
    !hasTerminalLifecycle || terminalTaskStatus === 'COMPLETED'
      ? event.content || (typeof event.result?.value === 'string' ? event.result.value : '')
      : ''
  const finalContent =
    incomingContent.length > existingMessage.content.length
      ? incomingContent
      : existingMessage.content || incomingContent

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

  const newMessages = new Map(state.messages)
  newMessages.set(aiMessageId, {
    ...existingMessage,
    status: finalStatus,
    subtaskStatus: finalSubtaskStatus,
    content: finalContent,
    timestamp: event.hasError ? Date.now() : existingMessage.timestamp,
    isReasoningStreaming: false,
    error: event.hasError ? event.errorMessage : existingMessage.error,
    messageId: event.messageId ?? existingMessage.messageId,
    sources: event.sources || existingMessage.sources,
    result: mergedResult,
  })

  const newStatus = isActiveStreamEvent ? 'ready' : state.status
  const runtime: TaskRuntimeState = {
    ...state.runtime,
    taskStatus: isActiveStreamEvent ? terminalTaskStatus : state.runtime.taskStatus,
    phase: isActiveStreamEvent
      ? getRuntimePhaseForTaskStatus(terminalTaskStatus, false)
      : state.runtime.phase,
    activeStreamSubtaskId: isActiveStreamEvent ? undefined : state.runtime.activeStreamSubtaskId,
    activeStreamStartedAt: isActiveStreamEvent ? undefined : state.runtime.activeStreamStartedAt,
    activeStreamLastActivityAt: isActiveStreamEvent
      ? undefined
      : state.runtime.activeStreamLastActivityAt,
    localStreamCursor: isActiveStreamEvent ? 0 : state.runtime.localStreamCursor,
    lastStatusUpdatedAt: isActiveStreamEvent
      ? (state.runtime.deferredTerminalUpdatedAt ?? state.runtime.lastStatusUpdatedAt)
      : state.runtime.lastStatusUpdatedAt,
    lastTerminalStatusUpdatedAt: isActiveStreamEvent
      ? (state.runtime.deferredTerminalUpdatedAt ?? state.runtime.lastTerminalStatusUpdatedAt)
      : state.runtime.lastTerminalStatusUpdatedAt,
    hasTerminalStatus: isActiveStreamEvent ? true : state.runtime.hasTerminalStatus,
    deferredTerminalStatus: isActiveStreamEvent ? undefined : state.runtime.deferredTerminalStatus,
    deferredTerminalUpdatedAt: isActiveStreamEvent
      ? undefined
      : state.runtime.deferredTerminalUpdatedAt,
  }

  return {
    ...state,
    status: newStatus,
    messages: newMessages,
    isStopping: isActiveStreamEvent ? false : state.isStopping,
    runtime,
    derived: deriveRuntimeState(runtime),
  }
}

export function reduceChatErrorEvent({
  state,
  event,
  deriveRuntimeState,
}: ChatEventReducerParams<Extract<Event, { type: 'CHAT_ERROR' }>>): TaskMachineInternalState {
  const aiMessageId = generateMessageId('ai', event.subtaskId)
  const existingMessage = state.messages.get(aiMessageId)

  if (!existingMessage) {
    console.warn('[TaskStateMachine] CHAT_ERROR for unknown message', event.subtaskId)
    return state
  }

  if (isTerminalTaskStatus(state.runtime.taskStatus)) return state

  const isActiveStreamEvent =
    state.status === 'streaming' && state.runtime.activeStreamSubtaskId === event.subtaskId
  if (!isActiveStreamEvent) return state

  const newMessages = new Map(state.messages)
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
    ...state.runtime,
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

  return {
    ...state,
    status: 'error',
    messages: newMessages,
    error: event.error,
    isStopping: false,
    runtime,
    derived: deriveRuntimeState(runtime),
  }
}

export function reduceChatCancelledEvent({
  state,
  event,
  deriveRuntimeState,
}: ChatEventReducerParams<Extract<Event, { type: 'CHAT_CANCELLED' }>>): TaskMachineInternalState {
  const aiMessageId = generateMessageId('ai', event.subtaskId)
  const existingMessage = state.messages.get(aiMessageId)

  if (!existingMessage) return state
  if (isTerminalTaskStatus(state.runtime.taskStatus)) return state

  const newMessages = new Map(state.messages)
  newMessages.set(aiMessageId, {
    ...existingMessage,
    status: 'completed',
    subtaskStatus: 'CANCELLED',
  })

  const newStatus =
    state.status === 'streaming' && state.runtime.activeStreamSubtaskId === event.subtaskId
      ? 'ready'
      : state.status
  if (newStatus === state.status) return state

  const runtime: TaskRuntimeState = {
    ...state.runtime,
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

  return {
    ...state,
    status: newStatus,
    messages: newMessages,
    isStopping: false,
    runtime,
    derived: deriveRuntimeState(runtime),
  }
}

export function reduceSendAcceptedEvent({
  state,
  event,
  deriveRuntimeState,
}: ChatEventReducerParams<Extract<Event, { type: 'SEND_ACCEPTED' }>>): TaskMachineInternalState {
  const activeStreamSubtaskId = state.runtime.activeStreamSubtaskId
  const runtime: TaskRuntimeState = {
    ...state.runtime,
    taskId: state.taskId,
    taskStatus: 'RUNNING',
    phase: getRuntimePhaseForTaskStatus('RUNNING', Boolean(activeStreamSubtaskId)),
    activeStreamSubtaskId,
    lastStatusUpdatedAt: event.acceptedAt,
    lastTerminalStatusUpdatedAt: undefined,
    hasTerminalStatus: false,
    deferredTerminalStatus: undefined,
    deferredTerminalUpdatedAt: undefined,
    serverConfirmedNoStream: false,
  }

  return {
    ...state,
    status: activeStreamSubtaskId === undefined ? 'ready' : 'streaming',
    error: null,
    isStopping: false,
    runtime,
    derived: deriveRuntimeState(runtime),
  }
}

function mergeChunkBlocks(
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
