import type { PrivateDraftPersistence } from './private/privateDraftPersistence'

interface DraftIntent {
  clientMessageId: string
  body: string
  revision: number
}

/** One existing draft scope owns its revision and explicit native message intent. */
export class ExperienceDraftSession {
  revision = 0
  value: string
  error: unknown = null
  private pending = 0
  private intent: DraftIntent | null = null
  private restoreFailed = false
  private listeners = new Set<(value: string, error: unknown) => void>()
  private readonly revisionKey: string
  private readonly intentKey: string
  private readonly persistence: PrivateDraftPersistence
  private readonly inputKey: string

  constructor(persistence: PrivateDraftPersistence, inputKey: string, initialValue: string) {
    this.persistence = persistence
    this.inputKey = inputKey
    this.value = initialValue
    this.revisionKey = `revision:${inputKey}`
    this.intentKey = `publication:${inputKey}`
    try {
      this.restore()
    } catch (cause) {
      this.revision = 0
      this.error = cause
      this.restoreFailed = true
    }
  }

  private restore(expectedValue?: string) {
    const values = this.persistence.read()
    const value =
      values[this.inputKey] ?? (values[this.revisionKey] === undefined ? this.value : '')
    if (expectedValue !== undefined && value !== expectedValue)
      throw new Error('Draft was replaced')
    this.value = value
    const revision = Number(values[this.revisionKey] ?? 0)
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid draft revision')
    const raw = values[this.intentKey]
    const intent = raw ? (JSON.parse(raw) as DraftIntent) : null
    if (
      raw &&
      (!intent ||
        typeof intent.clientMessageId !== 'string' ||
        !intent.clientMessageId.trim() ||
        intent.body !== value.trim() ||
        intent.revision !== revision)
    )
      throw new Error('Invalid draft publication intent')
    this.revision = revision
    this.intent = intent
    this.restoreFailed = false
    this.error = null
  }

  get unused() {
    return !this.listeners.size && !this.pending
  }

  subscribe(listener: (value: string, error: unknown) => void) {
    this.listeners.add(listener)
    listener(this.value, this.error)
    return () => {
      this.listeners.delete(listener)
    }
  }

  update(value: string) {
    if (this.value === value) return
    this.revision += 1
    this.value = value
    this.intent = null
    this.restoreFailed = false
    this.error = null
    try {
      this.persist()
    } catch (cause) {
      this.error = cause
    }
    this.notify()
  }

  private notify() {
    for (const listener of this.listeners) listener(this.value, this.error)
  }

  private persist() {
    this.persistence.writeEntries({
      [this.inputKey]: this.value,
      [this.revisionKey]: String(this.revision),
      [this.intentKey]: this.intent ? JSON.stringify(this.intent) : '',
    })
  }

  retain(value: string) {
    if (this.restoreFailed) {
      try {
        this.restore(value)
      } catch (cause) {
        this.error = cause
        this.notify()
        throw cause
      }
    }
    if (value !== this.value) throw new Error('Draft was replaced')
    this.intent ??= {
      clientMessageId: crypto.randomUUID(),
      body: value.trim(),
      revision: this.revision,
    }
    try {
      this.persist()
      this.error = null
      this.notify()
    } catch (cause) {
      this.error = cause
      this.notify()
      throw cause
    }
    const revision = this.revision
    const clientMessageId = this.intent.clientMessageId
    this.pending += 1
    return {
      clientMessageId,
      clearIfUnchanged: () => {
        if (this.revision !== revision || this.value !== value) return
        const saved = this.persistence.read()
        if (
          Number(saved[this.revisionKey] ?? 0) !== revision ||
          saved[this.inputKey] !== value ||
          JSON.parse(saved[this.intentKey] ?? 'null')?.clientMessageId !== clientMessageId
        )
          return
        this.update('')
      },
      release: () => {
        this.pending -= 1
      },
    }
  }
}
