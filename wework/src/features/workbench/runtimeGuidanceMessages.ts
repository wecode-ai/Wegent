import type { RuntimePaneMessageAction } from './runtimePaneMessages'
import type { RuntimeGuidanceAppliedPayload } from '@/types/api'
import type { RuntimePaneQueuedMessage, WorkbenchMessage } from '@/types/workbench'
import { persistAttachmentReferences } from '@/lib/attachments'

export interface AppliedRuntimeGuidanceMessage extends WorkbenchMessage {
  role: 'user'
  status: 'done'
  createdAt: string
  runtimeGuidance: true
}

export interface GuidanceSplitBoundary {
  prefix: string
}

export type GuidanceSplitBoundaries = Map<string, GuidanceSplitBoundary>

export function createAppliedRuntimeGuidanceMessage(
  guidanceMessage: RuntimePaneQueuedMessage,
  payload: RuntimeGuidanceAppliedPayload
): AppliedRuntimeGuidanceMessage {
  return {
    id: guidanceMessage.id,
    role: 'user',
    content: guidanceMessage.content,
    ...(guidanceMessage.attachments && {
      attachments: persistAttachmentReferences(guidanceMessage.attachments),
    }),
    status: 'done',
    createdAt: new Date(payload.appliedAtMs).toISOString(),
    runtimeGuidance: true,
    ...(guidanceMessage.runtimeGoalRequest && { runtimeGoalRequest: true }),
    ...(guidanceMessage.codeComments?.length && { codeComments: guidanceMessage.codeComments }),
  }
}

export function insertAppliedRuntimeGuidance(
  messages: WorkbenchMessage[],
  guidanceMessage: AppliedRuntimeGuidanceMessage,
  splitBoundaries: GuidanceSplitBoundaries
): WorkbenchMessage[] {
  const assistantIndex = findLastIndex(
    messages,
    message => message.role === 'assistant' && message.status === 'streaming'
  )
  if (assistantIndex < 0) {
    return [...messages, guidanceMessage]
  }

  const assistantMessage = messages[assistantIndex]
  if (assistantMessage.subtaskId) {
    splitBoundaries.set(assistantMessage.subtaskId, {
      prefix: assistantMessage.content,
    })
  }

  const frozenAssistantMessage: WorkbenchMessage = {
    ...assistantMessage,
    id: `${assistantMessage.id}-before-guidance-${guidanceMessage.id}`,
    subtaskId: undefined,
    status: 'done',
    runtimeStatus: 'done',
    streamTextOffset: undefined,
    completedAt: guidanceMessage.createdAt,
    runtimeGuidanceSplitBefore: true,
    blocks: freezeGuidanceAssistantBlocks(assistantMessage.blocks),
  }

  const continuationMessage = assistantMessage.subtaskId
    ? createGuidanceContinuationAssistantMessage(
        { ...assistantMessage, subtaskId: assistantMessage.subtaskId },
        guidanceMessage
      )
    : null

  return [
    ...messages.slice(0, assistantIndex),
    frozenAssistantMessage,
    guidanceMessage,
    ...(continuationMessage ? [continuationMessage] : []),
    ...messages.slice(assistantIndex + 1),
  ]
}

export function transformRuntimePaneActionForGuidanceSplits(
  action: RuntimePaneMessageAction,
  splitBoundaries: GuidanceSplitBoundaries
): RuntimePaneMessageAction {
  if (!('subtaskId' in action) || typeof action.subtaskId !== 'string') return action

  const boundary = splitBoundaries.get(action.subtaskId)
  if (!boundary) return action

  switch (action.type) {
    case 'assistant_chunk':
      return action
    case 'assistant_done': {
      splitBoundaries.delete(action.subtaskId)
      return {
        ...action,
        content:
          action.content === undefined
            ? undefined
            : trimGuidanceSplitPrefix(boundary.prefix, action.content),
      }
    }
    case 'assistant_error':
    case 'assistant_cancelled':
      splitBoundaries.delete(action.subtaskId)
      return action
    default:
      return action
  }
}

function createGuidanceContinuationAssistantMessage(
  assistantMessage: WorkbenchMessage & { subtaskId: string },
  guidanceMessage: AppliedRuntimeGuidanceMessage
): WorkbenchMessage {
  return {
    ...assistantMessage,
    id: `${assistantMessage.id}-after-guidance-${guidanceMessage.id}`,
    content: '',
    status: 'streaming',
    runtimeStatus: 'streaming',
    streamTextOffset: undefined,
    blocks: [
      {
        id: `${guidanceMessage.id}-guidance`,
        subtaskId: assistantMessage.subtaskId,
        type: 'tool',
        toolName: 'conversation_guidance',
        toolInput: { message: guidanceMessage.content },
        status: 'done',
        createdAt: getMessageCreatedAtMs(guidanceMessage.createdAt),
      },
    ],
    runtimeGuidanceContinuation: true,
    contentTruncated: undefined,
    contentOriginalChars: undefined,
    completedAt: undefined,
    stoppedNotice: false,
  }
}

function trimGuidanceSplitPrefix(prefix: string, content: string): string {
  if (!prefix || !content) return content

  if (content.startsWith(prefix)) {
    return content.slice(prefix.length)
  }
  return content
}

function freezeGuidanceAssistantBlocks(
  blocks: WorkbenchMessage['blocks']
): WorkbenchMessage['blocks'] {
  return blocks?.map(block => {
    if (block.status !== 'streaming' && block.status !== 'pending') return block
    return {
      ...block,
      status: 'done',
    }
  })
}

function getMessageCreatedAtMs(createdAt: string): number {
  const timestamp = new Date(createdAt).getTime()
  return Number.isFinite(timestamp) ? timestamp : Date.now()
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return index
  }
  return -1
}
