import type { RuntimePaneQueuedMessage } from '@wegent/chat-core/conversation-queue'
import type { TaskReplyCard, TaskCardDispatchResult } from './taskCardReply'

export interface TaskReplyQueueSchedule {
  scope: string
  cards: TaskReplyCard[]
  enabled: boolean
  busy(card: TaskReplyCard): boolean
  dispatch(card: TaskReplyCard, reply: RuntimePaneQueuedMessage): Promise<TaskCardDispatchResult>
  sendFailedText: string
}

export interface TaskReplyQueueStorage {
  read(scope: string): RuntimePaneQueuedMessage[]
  write(scope: string, messages: RuntimePaneQueuedMessage[]): void
}
const empty: RuntimePaneQueuedMessage[] = []

/** Queue entries and dispatch claims survive the lifetime of an individual drawer. */
export class TaskReplyQueueStore {
  private queues = new Map<string, RuntimePaneQueuedMessage[]>()
  private errors = new Map<string, string>()
  private claimedIssues = new Set<string>()
  private listeners = new Set<() => void>()
  private revision = 0
  private storage?: TaskReplyQueueStorage
  constructor(storage?: TaskReplyQueueStorage) {
    this.storage = storage
  }
  getSnapshot = () => this.revision
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  /** A dispatch may use only the queue and input context observed by a committed reader. */
  observeSchedule(listener: () => void, schedule: TaskReplyQueueSchedule, version: number) {
    const stop = this.subscribe(listener)
    try {
      if (version === this.revision && schedule.enabled) this.dispatchNext(schedule)
    } catch (cause) {
      stop()
      throw cause
    }
    return stop
  }

  private dispatchNext(schedule: TaskReplyQueueSchedule) {
    const { scope, cards, busy } = schedule
    const candidate = cards
      .flatMap(card => {
        if (busy(card)) return []
        const reply = this.get(`${scope}:${card.root.messageId}`).find(
          message => message.status === 'queued'
        )
        return reply ? [{ card, reply }] : []
      })
      .sort((a, b) => a.reply.createdAt.localeCompare(b.reply.createdAt))[0]
    if (!candidate) return
    const key = `${scope}:${candidate.card.root.messageId}`
    if (this.claim(scope, key, candidate.reply.id))
      void this.deliver(schedule, key, candidate.card, candidate.reply)
  }

  private async deliver(
    schedule: TaskReplyQueueSchedule,
    key: string,
    card: TaskReplyCard,
    reply: RuntimePaneQueuedMessage
  ) {
    let result: TaskCardDispatchResult
    try {
      result = await schedule.dispatch(card, reply)
    } catch (cause) {
      result = {
        ok: false,
        persisted: false,
        error: cause instanceof Error ? cause.message : schedule.sendFailedText,
      }
    }
    try {
      this.update(key, current =>
        result.ok || result.persisted
          ? current.filter(message => message.id !== reply.id)
          : current.map(message =>
              message.id === reply.id
                ? { ...message, status: 'failed', error: result.error ?? schedule.sendFailedText }
                : message
            )
      )
      if (!result.ok) this.setError(key, result.error ?? schedule.sendFailedText)
    } finally {
      this.release(schedule.scope)
    }
  }

  private publish() {
    this.revision++
    this.listeners.forEach(listener => listener())
  }
  get(scope: string) {
    return this.storage ? this.storage.read(scope) : (this.queues.get(scope) ?? empty)
  }
  error(scope: string) {
    return this.errors.get(scope) ?? null
  }
  setError(scope: string, error: string | null) {
    if (error) this.errors.set(scope, error)
    else this.errors.delete(scope)
    this.publish()
  }
  update(
    scope: string,
    change: (current: RuntimePaneQueuedMessage[]) => RuntimePaneQueuedMessage[]
  ) {
    const next = change(this.get(scope))
    if (this.storage) this.storage.write(scope, next)
    else this.queues.set(scope, next)
    this.publish()
  }
  claim(issueScope: string, cardScope: string, id: string) {
    if (
      this.claimedIssues.has(issueScope) ||
      !this.get(cardScope).some(message => message.id === id && message.status === 'queued')
    )
      return false
    this.claimedIssues.add(issueScope)
    this.errors.delete(cardScope)
    this.update(cardScope, current =>
      current.map(message =>
        message.id === id ? { ...message, status: 'sending', error: undefined } : message
      )
    )
    return true
  }
  release(issueScope: string) {
    this.claimedIssues.delete(issueScope)
    this.publish()
  }
}
