import type { RuntimePaneQueuedMessage } from '@wegent/chat-core/conversation-queue'
import type { RuntimeSendRequest } from '@wegent/chat-core/runtime-task-api-types'
import type { RuntimeGuidanceAppliedPayload } from '@wegent/chat-core/runtime-stream-types'
import { localRuntimeAttachments, remoteAttachmentIds } from '@wegent/chat-core/runtime-attachments'

export interface RuntimeConversationQueuePort<Lifecycle = unknown> {
  send(message: RuntimePaneQueuedMessage): Promise<{ sent: boolean; error?: string | null }>
  guide(message: RuntimePaneQueuedMessage): Promise<{ sent: boolean; error?: string | null }>
  lifecycle(): Lifecycle
  lifecycleChanged(previous: Lifecycle): boolean
  isBusyError(error: string | null): boolean
  sendFailedText: string
  guidanceFailedText: string
}

/** The same pending-message state machine is used in PC and browser side conversations. */
export class RuntimeConversationQueue<Lifecycle = unknown> {
  private messages: RuntimePaneQueuedMessage[] = []
  private listeners = new Set<() => void>()
  private blocked = new Map<string, Lifecycle>()
  private awaitingNextTurn: { lifecycle: Lifecycle } | null = null
  getSnapshot = () => this.messages
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(change: (messages: RuntimePaneQueuedMessage[]) => RuntimePaneQueuedMessage[]) {
    this.messages = change(this.messages)
    this.listeners.forEach(listener => listener())
  }
  enqueue(message: RuntimePaneQueuedMessage, blockedLifecycle?: { value: Lifecycle }) {
    if (this.messages.some(item => item.id === message.id)) return
    if (blockedLifecycle) this.blocked.set(message.id, blockedLifecycle.value)
    this.update(messages => [...messages, message])
  }
  take(id: string) {
    const message = this.messages.find(item => item.id === id && item.status !== 'sending')
    if (!message) return null
    this.blocked.delete(id)
    this.update(messages => messages.filter(item => item.id !== id))
    return message
  }
  cancel(id: string) {
    this.take(id)
  }
  async pump(port: RuntimeConversationQueuePort<Lifecycle>, busy: boolean) {
    // Observe active turns before they return to an identical idle snapshot.
    if (this.awaitingNextTurn && port.lifecycleChanged(this.awaitingNextTurn.lifecycle)) {
      this.awaitingNextTurn = null
    }
    if (busy || this.messages.some(message => message.status === 'sending')) return
    if (this.awaitingNextTurn) return
    const message = this.messages.find(item => item.status === 'queued')
    if (!message) return
    if (
      this.blocked.has(message.id) &&
      !port.lifecycleChanged(this.blocked.get(message.id) as Lifecycle)
    )
      return
    await this.send(message.id, port)
  }
  async send(id: string, port: RuntimeConversationQueuePort<Lifecycle>): Promise<boolean> {
    const message = this.messages.find(item => item.id === id && item.status !== 'sending')
    if (!message || this.messages.some(item => item.status === 'sending')) return false
    this.awaitingNextTurn = { lifecycle: port.lifecycle() }
    this.patch(id, { status: 'sending', error: undefined, deliveryMode: 'message' })
    try {
      const result = await port.send(message)
      if (result.sent) {
        this.remove(id)
        return true
      }
      this.awaitingNextTurn = null
      this.rejectSend(id, result.error || port.sendFailedText, port)
    } catch (cause) {
      this.awaitingNextTurn = null
      this.rejectSend(id, cause instanceof Error ? cause.message : port.sendFailedText, port)
    }
    return false
  }
  async guide(
    id: string,
    port: RuntimeConversationQueuePort<Lifecycle>,
    busy: boolean
  ): Promise<boolean> {
    if (!busy) return this.send(id, port)
    const message = this.messages.find(item => item.id === id && item.status !== 'sending')
    if (!message) return false
    this.blocked.delete(id)
    this.patch(id, { status: 'sending', deliveryMode: 'guidance', error: undefined })
    try {
      const result = await port.guide(message)
      if (result.sent) return true
      this.fail(id, result.error || port.guidanceFailedText)
    } catch (cause) {
      this.fail(id, cause instanceof Error ? cause.message : port.guidanceFailedText)
    }
    return false
  }
  applyGuidance(payload: RuntimeGuidanceAppliedPayload) {
    const message = this.messages.find(
      item =>
        item.status === 'sending' &&
        item.deliveryMode === 'guidance' &&
        (payload.clientGuidanceId
          ? item.id === payload.clientGuidanceId
          : item.content === payload.message)
    )
    if (message) this.remove(message.id)
    return message ?? null
  }
  reconcileGuidance(appliedMessageIds: ReadonlySet<string>) {
    for (const message of this.messages) {
      if (message.deliveryMode === 'guidance' && appliedMessageIds.has(message.id))
        this.remove(message.id)
    }
  }
  private patch(id: string, patch: Partial<RuntimePaneQueuedMessage>) {
    if (this.messages.some(item => item.id === id))
      this.update(messages => messages.map(item => (item.id === id ? { ...item, ...patch } : item)))
  }
  private remove(id: string) {
    this.blocked.delete(id)
    this.update(messages => messages.filter(item => item.id !== id))
  }
  private fail(id: string, error: string) {
    this.blocked.delete(id)
    this.patch(id, { status: 'failed', deliveryMode: undefined, notice: undefined, error })
  }
  private rejectSend(id: string, error: string, port: RuntimeConversationQueuePort<Lifecycle>) {
    if (port.isBusyError(error)) {
      this.blocked.set(id, port.lifecycle())
      this.patch(id, { status: 'queued', error: undefined })
    } else {
      this.fail(id, error)
    }
  }
}

export function runtimeQueuedMessageRequest(
  context: Omit<RuntimeSendRequest, 'message' | 'clientUserMessageId'>,
  message: RuntimePaneQueuedMessage
): RuntimeSendRequest {
  const attachmentIds = remoteAttachmentIds(message.attachments ?? [])
  const attachments = localRuntimeAttachments(message.attachments ?? [])
  const modelId = message.modelId ?? context.modelId
  const modelType = message.modelType ?? context.modelType
  const modelOptions = message.modelOptions ?? context.modelOptions
  return {
    ...context,
    message: message.content,
    clientUserMessageId: message.id,
    ...(message.modelId ? { modelId: message.modelId, modelType: message.modelType } : {}),
    ...(message.modelOptions ? { modelOptions: message.modelOptions } : {}),
    ...(modelId
      ? { modelSelection: { modelName: modelId, modelType, options: modelOptions ?? {} } }
      : {}),
    ...(attachmentIds.length ? { attachmentIds } : {}),
    ...(attachments.length ? { attachments } : {}),
  }
}

export function isRuntimeQueueBusyError(error: string | null, localizedMessage: string): boolean {
  const normalized = error?.trim().toLowerCase()
  return (
    normalized?.includes('runtime task is already running') === true ||
    normalized === localizedMessage.trim().toLowerCase()
  )
}
