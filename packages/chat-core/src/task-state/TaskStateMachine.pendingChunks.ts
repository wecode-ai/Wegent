// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { MessageBlock } from '../message-blocks'
import { mergeStreamingBlocks } from './TaskStateMachine.blockMerging'
import { generateMessageId, mergeChunkContent } from './TaskStateMachine.messageUtils'
import type {
  PendingChunkEvent,
  TaskMachineInternalState,
  TaskRuntimeDerivedState,
  TaskRuntimeState,
  UnifiedMessage,
} from './TaskStateMachine.types'

type DeriveRuntimeState = (runtime: TaskRuntimeState) => TaskRuntimeDerivedState

interface ApplyPendingChunksParams {
  state: TaskMachineInternalState
  pendingChunks: PendingChunkEvent[]
  deriveRuntimeState: DeriveRuntimeState
}

interface ApplyPendingChunksResult {
  state: TaskMachineInternalState
  pendingChunks: PendingChunkEvent[]
  notifyListeners: boolean
}

export function applyPendingChunksToState({
  state,
  pendingChunks,
  deriveRuntimeState,
}: ApplyPendingChunksParams): ApplyPendingChunksResult {
  if (pendingChunks.length === 0) {
    return { state, pendingChunks, notifyListeners: false }
  }

  let nextState = state

  for (const chunk of pendingChunks) {
    const aiMessageId = generateMessageId('ai', chunk.subtaskId)
    const existingMessage = nextState.messages.get(aiMessageId)

    if (!existingMessage) {
      console.warn('[TaskStateMachine] Pending chunk skipped - message not found', {
        subtaskId: chunk.subtaskId,
        taskId: nextState.taskId,
      })
      continue
    }

    if (existingMessage.status !== 'streaming') {
      continue
    }

    const contentMerge = mergeChunkContent(existingMessage.content, chunk.content, chunk.offset)
    const newMessages = new Map(nextState.messages)
    const updatedMessage: UnifiedMessage = {
      ...existingMessage,
      content: contentMerge.content,
    }

    if (chunk.result?.reasoning_chunk) {
      updatedMessage.reasoningContent =
        (existingMessage.reasoningContent || '') + chunk.result.reasoning_chunk
      updatedMessage.isReasoningStreaming = true
    } else if (chunk.result?.reasoning_content) {
      updatedMessage.reasoningContent = chunk.result.reasoning_content
    }

    if (chunk.content) {
      updatedMessage.isReasoningStreaming = false
    }

    const mergedBlocks = mergeBlocksFromPendingChunk(
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
      ...nextState.runtime,
      phase: 'streaming',
      activeStreamSubtaskId: chunk.subtaskId,
      localStreamCursor: updatedMessage.content.length,
      localLastChunkAt: Date.now(),
    }

    nextState = {
      ...nextState,
      messages: newMessages,
      runtime,
      derived: deriveRuntimeState(runtime),
    }
  }

  return { state: nextState, pendingChunks: [], notifyListeners: true }
}

function mergeBlocksFromPendingChunk(
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
