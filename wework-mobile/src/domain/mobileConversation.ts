import {
  hydrateRuntimeConversationTurns,
  mergeRuntimeConversationTurns,
  projectRuntimeConversationTurns,
  reduceRuntimeConversationTurns,
} from '../../../packages/chat-core/src/runtime-turns'
import { createRuntimeTaskStreamHandlers } from '../../../packages/chat-core/src/runtime-stream-handlers'
import {
  createResponseApiStreamState,
  emitResponseApiEvent,
} from '../../../packages/chat-core/src/response-api-stream'
import type {
  RuntimeConversationTurn,
  RuntimePaneMessageAction,
} from '../../../packages/chat-core/src/runtime-conversation'
import { requestUserInputResponseKey } from '../../../packages/chat-core/src/runtime-user-input'
import {
  applyMobileUserInputResponse,
  preserveMobileUserInput,
  resolveMobileUserInput,
  settleMobileUserInput,
} from './requestUserInput'
import { mobileMessagesFromWorkbench } from './mobileMessagePresentation'
import { reconcileCachedRuntimeCommands } from './runtimeTranscript'
import type { ChatAction, RuntimeStreamEvent } from './chatActions'
import type { ChatMessage, RuntimeTaskAddress, RuntimeTranscriptResponse } from '@/types/runtime'

/** Own canonical turns exactly like the PC remote-device cache; messages are a projection. */
export class MobileConversation {
  turns: RuntimeConversationTurn[] = []
  messages: ChatMessage[] = []
  private readonly delivered = new Set<string>()
  private readonly settledInputs = new Map<string, ChatAction>()
  private readonly superseded = new Set<string>()
  private buffered: RuntimePaneMessageAction[] | null = null
  private hydrationBase: RuntimeConversationTurn[] = []
  private threadId: string | null = null
  private streamState = createResponseApiStreamState()
  private handlers?: ReturnType<typeof createRuntimeTaskStreamHandlers>

  constructor(private address?: RuntimeTaskAddress) {
    this.bind(address)
  }

  bind(address?: RuntimeTaskAddress): void {
    this.address = address
    this.streamState = createResponseApiStreamState()
    this.handlers = address
      ? createRuntimeTaskStreamHandlers(address, {
          onMessageAction: action => this.apply(action),
          onGuidanceApplied: payload => {
            const id = payload.clientGuidanceId ?? payload.guidanceId
            const previous = this.turns
              .flatMap(turn => turn.items)
              .find(item => item.type === 'user_message' && item.message.id === id)
            this.apply({
              type: 'guidance_applied',
              subtaskId: payload.subtaskId,
              message: {
                ...(previous?.type === 'user_message' ? previous.message : {}),
                id,
                role: 'user',
                content: payload.message,
                status: 'done',
                runtimeGuidance: true,
                createdAt: new Date(payload.appliedAtMs).toISOString(),
              },
            })
          },
        })
      : undefined
  }

  dispatch(action: ChatAction): void {
    switch (action.type) {
      case 'stream':
        this.receive(action.event)
        break
      case 'optimistic-user':
        this.apply({
          type: 'user_added',
          message: {
            id: action.id,
            content: action.content,
            attachments: action.attachments,
            role: 'user',
            status: 'pending',
            createdAt: new Date(action.createdAt).toISOString(),
          },
        })
        break
      case 'user-delivered':
        this.delivered.add(action.id)
        this.turns = this.turns.map(turn => ({
          ...turn,
          items: turn.items.map(item =>
            item.type === 'user_message' && item.message.id === action.id
              ? { ...item, message: { ...item.message, status: 'done' } }
              : item
          ),
        }))
        break
      case 'fail': {
        const turn = this.turns.find(
          candidate =>
            candidate.id === action.id ||
            candidate.clientUserMessageId === action.id ||
            projectRuntimeConversationTurns([candidate]).some(message => message.id === action.id)
        )
        this.apply({
          type: 'assistant_error',
          subtaskId: turn?.id ?? action.id,
          error: action.error,
        })
        break
      }
      case 'user-input-response': {
        const key = requestUserInputResponseKey(action.response)
        if (key) this.settledInputs.set(key, action)
        break
      }
      case 'user-input-cancelled':
        this.settledInputs.set(action.key, action)
        break
    }
    this.project()
  }

  beginHydration(): void {
    this.hydrationBase = this.turns
    this.buffered = []
  }

  endHydration(): void {
    this.buffered = null
    this.hydrationBase = []
  }

  hydrate(transcript: RuntimeTranscriptResponse, loaded: boolean): boolean {
    const changedThread = Boolean(
      transcript.threadId && this.threadId && transcript.threadId !== this.threadId
    )
    if (changedThread) this.superseded.clear()
    if (transcript.threadId) this.threadId = transcript.threadId
    const snapshot = this.canonicalTurns(transcript)
    const snapshotIds = new Set(
      projectRuntimeConversationTurns(snapshot).map(message => message.id)
    )
    const resetPagination =
      changedThread ||
      (loaded &&
        this.messages.length > 0 &&
        !this.messages.some(message => snapshotIds.has(message.id)))
    const base = this.buffered ? this.hydrationBase : this.turns
    const hydrationBase = changedThread
      ? []
      : resetPagination
        ? base.filter(turn => turn.id === null)
        : base
    const hydrated = hydrateRuntimeConversationTurns(
      hydrationBase,
      snapshot,
      this.buffered ?? [],
      false,
      [...this.superseded]
    )
    this.turns =
      transcript.runtime === 'codex'
        ? reconcileCachedRuntimeCommands(
            hydrationBase,
            snapshot,
            hydrated,
            Boolean(transcript.hasMoreBefore || transcript.beforeCursor)
          )
        : hydrated
    this.project()
    return resetPagination
  }

  prepend(transcript: RuntimeTranscriptResponse): void {
    const older = this.canonicalTurns(transcript)
    if (this.buffered) this.hydrationBase = mergeRuntimeConversationTurns(older, this.hydrationBase)
    this.turns = mergeRuntimeConversationTurns(older, this.turns).filter(
      turn => !turn.id || !this.superseded.has(turn.id)
    )
    this.project()
  }

  private canonicalTurns(transcript: RuntimeTranscriptResponse): RuntimeConversationTurn[] {
    if (!Array.isArray(transcript.turns))
      throw new Error('Runtime transcript is missing canonical turns')
    for (const id of transcript.supersededTurnIds ?? []) this.superseded.add(id)
    return transcript.turns
  }

  private receive(event: RuntimeStreamEvent): void {
    if (event.name === 'executor.event_lagged' || event.name === 'executor.runtime_replaced') {
      this.streamState = createResponseApiStreamState()
      return
    }
    if (!this.handlers || !this.address) throw new Error('Runtime conversation has no task address')
    emitResponseApiEvent(
      this.handlers,
      event.name,
      {
        deviceId: this.address.deviceId,
        taskId: this.address.taskId,
        ...event.payload,
      },
      this.streamState
    )
  }

  private apply(action: RuntimePaneMessageAction): void {
    this.buffered?.push(action)
    this.turns = reduceRuntimeConversationTurns(this.turns, action).filter(
      turn => !turn.id || !this.superseded.has(turn.id)
    )
  }

  private project(): void {
    let messages = preserveMobileUserInput(
      this.messages,
      mobileMessagesFromWorkbench(projectRuntimeConversationTurns(this.turns))
    )
    for (const action of this.settledInputs.values()) {
      if (action.type === 'user-input-response')
        messages = applyMobileUserInputResponse(messages, action.response)
      if (action.type === 'user-input-cancelled')
        messages = settleMobileUserInput(messages, action.key)
    }
    this.messages = resolveMobileUserInput(
      messages.map(message =>
        this.delivered.has(message.id) ? { ...message, pendingDelivery: false } : message
      )
    )
  }
}
