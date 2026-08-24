import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const MAX_HISTORY_ENTRIES = 5_000

export interface BrowserHistoryEntry {
  id: string
  url: string
  title: string | null
  visitTimeMs: number
}

export interface BrowserHistorySearch {
  text: string
  endTimeMs: number | null
  offset: number
  maxResults: number
}

export class BrowserHistoryStore {
  private entries: BrowserHistoryEntry[] = []
  private loaded = false
  private sequence = 0
  private operation = Promise.resolve()

  constructor(private readonly path: string) {}

  search(input: BrowserHistorySearch): Promise<BrowserHistoryEntry[]> {
    return this.run(async () => {
      await this.load()
      const needle = input.text.trim().toLocaleLowerCase()
      return this.entries
        .toReversed()
        .filter(entry => input.endTimeMs == null || entry.visitTimeMs < input.endTimeMs)
        .filter(
          entry =>
            !needle ||
            entry.url.toLocaleLowerCase().includes(needle) ||
            entry.title?.toLocaleLowerCase().includes(needle)
        )
        .slice(input.offset, input.offset + input.maxResults)
    })
  }

  recordVisit(url: string, visitTimeMs: number, title: string | null): Promise<string> {
    return this.run(async () => {
      await this.load()
      const id = `history-${visitTimeMs}-${++this.sequence}`
      this.entries.push({
        id,
        url,
        title: normalizedTitle(title),
        visitTimeMs,
      })
      if (this.entries.length > MAX_HISTORY_ENTRIES) {
        this.entries.splice(0, this.entries.length - MAX_HISTORY_ENTRIES)
      }
      await this.persist()
      return id
    })
  }

  backfillTitle(id: string, title: string): Promise<void> {
    return this.run(async () => {
      const normalized = normalizedTitle(title)
      if (!normalized) return
      await this.load()
      const entry = this.entries.find(candidate => candidate.id === id && candidate.title == null)
      if (!entry) return
      entry.title = normalized
      await this.persist()
    })
  }

  remove(ids: string[]): Promise<number> {
    return this.run(async () => {
      await this.load()
      const selected = new Set(ids)
      const previous = this.entries
      this.entries = previous.filter(entry => !selected.has(entry.id))
      const removed = previous.length - this.entries.length
      try {
        await this.persist()
      } catch (error) {
        this.entries = previous
        throw error
      }
      return removed
    })
  }

  clear(): Promise<void> {
    return this.run(async () => {
      await this.load()
      const previous = this.entries
      this.entries = []
      try {
        await this.persist()
      } catch (error) {
        this.entries = previous
        throw error
      }
    })
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action, action)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const parsed = JSON.parse(raw) as BrowserHistoryEntry[]
    this.entries = parsed
      .filter(isBrowserHistoryEntry)
      .sort((left, right) => left.visitTimeMs - right.visitTimeMs)
      .slice(-MAX_HISTORY_ENTRIES)
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.tmp`
    await writeFile(temporaryPath, JSON.stringify(this.entries), 'utf8')
    await rename(temporaryPath, this.path)
  }
}

function normalizedTitle(title: string | null): string | null {
  const normalized = title?.trim()
  return normalized || null
}

function isBrowserHistoryEntry(value: unknown): value is BrowserHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<BrowserHistoryEntry>
  return (
    typeof entry.id === 'string' &&
    typeof entry.url === 'string' &&
    (entry.title === null || typeof entry.title === 'string') &&
    typeof entry.visitTimeMs === 'number' &&
    Number.isFinite(entry.visitTimeMs)
  )
}
