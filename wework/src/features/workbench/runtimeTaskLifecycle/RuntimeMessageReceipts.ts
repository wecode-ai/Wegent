export interface ReceivedAssistantMessage {
  id: string
  createdAt: number
  text: string
}

interface Receipt {
  readAt: number
  baselineAt: number
  messages: Record<string, { at: number; unread: boolean }>
}

/** Persist identities and read markers only, never private message text. */
export class RuntimeMessageReceipts {
  private records: Record<string, Receipt> = Object.create(null)
  private readonly storageKey: string
  private listeners = new Set<() => void>()
  private revision = 0
  private readonly startedAt = Date.now()
  private readonly viewed = new Map<string, Set<string>>()

  constructor(storageKey: string) {
    this.storageKey = storageKey
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (
            !value ||
            typeof value !== 'object' ||
            !Number.isFinite(value.readAt) ||
            !value.messages ||
            typeof value.messages !== 'object'
          )
            continue
          const messages: Receipt['messages'] = Object.create(null)
          for (const [id, message] of Object.entries(value.messages)) {
            if (
              message &&
              typeof message === 'object' &&
              'at' in message &&
              typeof message.at === 'number' &&
              Number.isFinite(message.at) &&
              'unread' in message &&
              typeof message.unread === 'boolean'
            ) {
              messages[id] = { at: message.at, unread: message.unread }
            }
          }
          this.records[key] = {
            readAt: value.readAt,
            baselineAt: Number.isFinite(value.baselineAt) ? value.baselineAt : 0,
            messages,
          }
        }
      }
    } catch {
      /* Unavailable storage must not block conversation delivery. */
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getSnapshot = () => this.revision
  unreadCount(key: string): number {
    return Object.values(this.records[key]?.messages ?? {}).filter(message => message.unread).length
  }

  observe(
    key: string,
    messages: ReceivedAssistantMessage[],
    previouslyUnread: boolean
  ): ReceivedAssistantMessage[] {
    if (!messages.length) return []
    const initial = !this.records[key]
    const record = (this.records[key] ??= {
      readAt: 0,
      baselineAt: this.startedAt,
      messages: Object.create(null),
    })
    const newest = messages.reduce((latest, message) =>
      message.createdAt >= latest.createdAt ? message : latest
    )
    const incoming: ReceivedAssistantMessage[] = []
    let changed = initial
    for (const message of messages) {
      if (Object.hasOwn(record.messages, message.id)) continue
      const live = message.createdAt > this.startedAt
      const unread =
        !this.viewed.has(key) &&
        (initial
          ? live || (previouslyUnread && message.id === newest.id)
          : message.createdAt > Math.max(record.readAt, record.baselineAt))
      record.messages[message.id] = { at: message.createdAt, unread }
      if (unread && (!initial || live)) incoming.push(message)
      changed = true
    }
    if (this.viewed.has(key)) record.readAt = Math.max(record.readAt, Date.now(), newest.createdAt)
    if (changed) this.publish()
    return incoming
  }

  markRead(key: string): void {
    const record = this.records[key]
    if (!record) return
    const changed = Object.values(record.messages).some(message => message.unread)
    record.readAt = Object.values(record.messages).reduce(
      (latest, message) => Math.max(latest, message.at),
      Math.max(Date.now(), record.readAt)
    )
    for (const message of Object.values(record.messages)) message.unread = false
    if (changed) this.publish()
    else this.persist()
  }

  setViewed(key: string, viewed: boolean, viewId = 'default'): void {
    if (viewed) {
      const views = this.viewed.get(key) ?? new Set<string>()
      views.add(viewId)
      this.viewed.set(key, views)
      this.markRead(key)
    } else {
      const views = this.viewed.get(key)
      views?.delete(viewId)
      if (!views?.size) this.viewed.delete(key)
    }
  }

  merge(previousKey: string, key: string): void {
    const previous = this.records[previousKey]
    if (!previous || previousKey === key) return
    const current = this.records[key]
    const readAt = Math.max(previous.readAt, current?.readAt ?? 0)
    const messages = { ...previous.messages, ...current?.messages }
    for (const message of Object.values(messages)) {
      if (message.at <= readAt) message.unread = false
    }
    this.records[key] = {
      readAt,
      baselineAt: Math.max(previous.baselineAt, current?.baselineAt ?? 0),
      messages,
    }
    delete this.records[previousKey]
    const views = this.viewed.get(previousKey)
    if (views) {
      this.viewed.set(key, new Set([...(this.viewed.get(key) ?? []), ...views]))
      this.viewed.delete(previousKey)
    }
    this.publish()
  }

  private publish() {
    // Retain all unread messages; bound acknowledged history per conversation.
    for (const record of Object.values(this.records)) {
      const read = Object.entries(record.messages)
        .filter(([, value]) => !value.unread)
        .sort((a, b) => b[1].at - a[1].at)
      for (const [id] of read.slice(2000)) delete record.messages[id]
    }
    this.persist()
    this.revision += 1
    this.listeners.forEach(listener => listener())
  }

  private persist() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.records))
    } catch {
      /* Keep live state. */
    }
  }
}
