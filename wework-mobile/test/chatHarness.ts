import { MobileConversation } from '../src/domain/mobileConversation'
import { runtimeMessageToWorkbenchMessage } from '../../packages/chat-core/src/runtime-transcript'
import type { NormalizedRuntimeMessage } from '../../packages/chat-core/src/runtime'
import type {
  RuntimeConversationTurn,
  WorkbenchMessage,
} from '../../packages/chat-core/src/runtime-conversation'
import type { ChatAction, RuntimeStreamEvent } from '../src/domain/chatActions'
import type {
  ChatMessage,
  RuntimeTranscriptMessage,
  RuntimeTranscriptResponse,
} from '../src/types/runtime'
export type { ChatAction, RuntimeStreamEvent }

// Legacy test inputs describe display messages. Build canonical fixtures only in tests.
const owners = new WeakMap<ChatMessage[], MobileConversation>()
type FixtureAction =
  | ChatAction
  | { type: 'replace'; messages: RuntimeTranscriptMessage[] }
  | { type: 'prepend'; messages: RuntimeTranscriptMessage[] }
  | { type: 'merge-latest'; messages: RuntimeTranscriptMessage[] }

export function canonicalTestTranscript(
  transcript: RuntimeTranscriptResponse
): RuntimeTranscriptResponse {
  if (transcript.turns) return transcript
  const turns: RuntimeConversationTurn[] = []
  for (const raw of transcript.messages) {
    const message = runtimeMessageToWorkbenchMessage({
      ...raw,
      fileChanges:
        raw.fileChanges && 'source' in raw.fileChanges ? raw.fileChanges.source : raw.fileChanges,
      blocks: raw.blocks?.map(block => ({
        ...block,
        fileChanges:
          block.fileChanges && 'source' in block.fileChanges
            ? block.fileChanges.source
            : block.fileChanges,
      })),
      createdAt:
        typeof raw.createdAt === 'number' ? new Date(raw.createdAt).toISOString() : raw.createdAt,
    } as NormalizedRuntimeMessage)
    const id =
      message.subtaskId ??
      message.turnId ??
      (message.role === 'user' ? `fixture-user:${message.id}` : message.id)
    let turn = id ? turns.find(candidate => candidate.id === id) : undefined
    if (!turn) {
      turn = {
        id,
        position: raw.messageIndex,
        clientUserMessageId: message.role === 'user' ? message.id : undefined,
        status: message.status,
        items: [],
      }
      turns.push(turn)
    }
    if (message.role === 'user') {
      turn.items.push({
        id: raw.runtimeItemId ?? message.id,
        type: 'user_message',
        message: {
          ...message,
          role: 'user',
          runtimeGuidance:
            turn.items.some(item => item.type !== 'user_message') || message.runtimeGuidance,
        },
      })
    } else {
      turn.status = message.status
      turn.error = message.error
      turn.errorType = message.errorType
      turn.completedAt = message.completedAt
      const blocks = new Map(message.blocks?.map(block => [block.id, block]))
      const display =
        (raw as RuntimeTranscriptMessage & Pick<WorkbenchMessage, 'runtimeDisplayItems'>)
          .runtimeDisplayItems ?? raw.runtimeItems
      if (display?.length) {
        for (const item of display) {
          if (item.type === 'assistant_text')
            turn.items.push({ ...item, type: 'assistant_text', createdAt: message.createdAt ?? '' })
          else if (blocks.has(item.id)) {
            turn.items.push({ id: item.id, type: 'block', block: blocks.get(item.id)! })
            blocks.delete(item.id)
          }
        }
      } else if (message.content)
        turn.items.push({
          id: `text-${id}`,
          type: 'assistant_text',
          content: message.content,
          createdAt: message.createdAt ?? '',
        })
      for (const block of blocks.values()) turn.items.push({ id: block.id, type: 'block', block })
      turn.fileChanges =
        message.fileChanges ??
        message.blocks?.find(block => block.type === 'file_changes')?.fileChanges
    }
  }
  for (const turn of turns) turn.items = turn.items.map((item, position) => ({ ...item, position }))
  return { ...transcript, turns }
}

function owner(messages: ChatMessage[]): MobileConversation {
  const existing = owners.get(messages)
  if (existing) return existing
  const conversation = new MobileConversation({ deviceId: 'device-1', taskId: 'task-1' })
  if (messages.length)
    conversation.hydrate(
      canonicalTestTranscript({
        taskId: 'task-1',
        runtime: 'codex',
        workspacePath: '/work',
        messages: messages as unknown as RuntimeTranscriptMessage[],
      }),
      false
    )
  return conversation
}

export function chatReducer(messages: ChatMessage[], action: FixtureAction): ChatMessage[] {
  const conversation = action.type === 'replace' ? owner([]) : owner(messages)
  if (action.type === 'replace' || action.type === 'merge-latest' || action.type === 'prepend') {
    const transcript = canonicalTestTranscript({
      taskId: 'task-1',
      runtime: 'codex',
      workspacePath: '/work',
      messages: action.messages,
    })
    if (action.type === 'prepend') conversation.prepend(transcript)
    else conversation.hydrate(transcript, false)
  } else conversation.dispatch(action)
  owners.set(conversation.messages, conversation)
  return conversation.messages
}

// Live fixtures model the executor's turn/start before item notifications.
export function startStream(messages: ChatMessage[], event: RuntimeStreamEvent): ChatMessage[] {
  const conversation = owner(messages)
  const id = event.payload.subtaskId
  if (typeof id === 'string' && !conversation.turns.some(turn => turn.id === id)) {
    conversation.dispatch({
      type: 'stream',
      event: { name: 'response.created', payload: { subtaskId: id, data: {} } },
    })
  }
  owners.set(conversation.messages, conversation)
  return conversation.messages
}

export function hydrateRuntimeTranscript(
  previous: ChatMessage[],
  transcript: RuntimeTranscriptResponse,
  actions: ChatAction[],
  loaded: boolean
) {
  const conversation = owner(previous)
  conversation.beginHydration()
  for (const action of actions) conversation.dispatch(action)
  const resetPagination = conversation.hydrate(canonicalTestTranscript(transcript), loaded)
  conversation.endHydration()
  owners.set(conversation.messages, conversation)
  return { messages: conversation.messages, resetPagination }
}

export function appendDelta(previous: string, delta: string, offset: number): string {
  const event = (text: string, at: number): RuntimeStreamEvent => ({
    name: 'response.output_text.delta',
    payload: { subtaskId: 'unicode', data: { itemId: 'text', delta: text, block_offset: at } },
  })
  const initial = chatReducer(startStream([], event(previous, 0)), {
    type: 'stream',
    event: event(previous, 0),
  })
  return chatReducer(initial, { type: 'stream', event: event(delta, offset) }).at(-1)?.content ?? ''
}
