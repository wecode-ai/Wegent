import type { RuntimePaneQueuedMessage } from '@wegent/chat-core/conversation-queue'

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
