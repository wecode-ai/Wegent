// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { builtinCollaborationTemplates } from './builtins'
import { validateTemplate } from './document'
import {
  templateIdentity,
  type CollaborationTemplate,
  type CollaborationTemplateLibrary,
  type TemplateRecord,
} from './types'

export interface TemplateStoreState {
  records: TemplateRecord[]
  loading: boolean
  syncing: boolean
  error: string | null
}

/** One scoped store is shared by discovery, creation and settings in a host. */
export class CollaborationTemplateStore {
  private state: TemplateStoreState = {
    records: builtinCollaborationTemplates(),
    loading: true,
    syncing: false,
    error: null,
  }
  private listeners = new Set<() => void>()
  private writes: Promise<void> = Promise.resolve()
  private loaded: Promise<void> | null = null
  private synchronization: Promise<void> | null = null

  readonly library: CollaborationTemplateLibrary

  constructor(library: CollaborationTemplateLibrary) {
    this.library = library
  }

  getSnapshot = (): TemplateStoreState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(patch: Partial<TemplateStoreState>): void {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }

  load(): Promise<void> {
    this.loaded ??= this.library.persistence
      .read()
      .then(records => {
        const combined = new Map(
          this.state.records.map(record => [templateIdentity(record), record])
        )
        for (const record of records) {
          validateTemplate(record.document)
          if (
            record.source === 'personal' &&
            (record.ownerId !== this.library.ownerId ||
              record.document.metadata.namespace !== 'default')
          )
            throw new Error('invalid_template_scope')
          combined.set(templateIdentity(record), record)
        }
        this.update({
          records: [...combined.values()],
          loading: false,
          error: null,
        })
      })
      .catch(error => {
        this.update({
          loading: false,
          error: String(error instanceof Error ? error.message : error),
        })
        this.loaded = null
        throw error
      })
    return this.loaded
  }

  private commit(record: TemplateRecord): Promise<void> {
    const operation = this.writes.then(async () => {
      const records = this.state.records.filter(
        candidate => templateIdentity(candidate) !== templateIdentity(record)
      )
      records.push(record)
      await this.library.persistence.write(records.filter(record => record.source !== 'builtin'))
      this.update({ records, error: null })
    })
    this.writes = operation.catch(() => undefined)
    return operation
  }

  async save(document: CollaborationTemplate, ownerId: number): Promise<TemplateRecord> {
    await this.load()
    const normalized = validateTemplate(document)
    if (ownerId !== this.library.ownerId) throw new Error('invalid_template_scope')
    if (normalized.metadata.namespace !== 'default') throw new Error('personal_namespace')
    const existing = this.state.records.find(
      record =>
        record.ownerId === ownerId &&
        record.document.metadata.namespace === 'default' &&
        record.document.metadata.name === normalized.metadata.name
    )
    if (existing) throw new Error('duplicate_template')
    const record: TemplateRecord = {
      id: null,
      ownerId,
      document: normalized,
      source: 'personal',
      revision: null,
      pendingSync: true,
    }
    await this.commit(record)
    if (this.library.remote) await this.synchronize()
    return this.state.records.find(
      candidate => templateIdentity(candidate) === templateIdentity(record)
    )!
  }

  async download(id: number): Promise<TemplateRecord> {
    await this.load()
    if (!this.library.remote) throw new Error('connection_required')
    let record = await this.library.remote.get(id)
    if (record.ownerId !== 0 && record.ownerId !== this.library.ownerId) {
      await this.library.remote.install(id)
      record = await this.library.remote.get(id)
    }
    validateTemplate(record.document)
    if (
      this.state.records.some(
        candidate =>
          templateIdentity(candidate) === templateIdentity(record) && candidate.pendingSync
      )
    )
      throw new Error('pending_template_conflict')
    const downloaded: TemplateRecord = {
      ...record,
      source: record.ownerId === this.library.ownerId ? 'personal' : 'downloaded',
      pendingSync: false,
    }
    await this.commit(downloaded)
    return downloaded
  }

  /** A conflict stays pending. Reconnecting never publishes or overwrites a source. */
  synchronize(): Promise<void> {
    if (this.synchronization) return this.synchronization
    const remote = this.library.remote
    if (!remote) return Promise.resolve()
    this.synchronization = (async () => {
      await this.load()
      this.update({ syncing: true })
      const attempted = new Set<string>()
      while (true) {
        await this.writes
        const record = this.state.records.find(
          record => record.pendingSync && !attempted.has(templateIdentity(record))
        )
        if (!record) break
        attempted.add(templateIdentity(record))
        try {
          const saved = await remote.save(record.document, record.revision)
          await this.commit({
            ...saved,
            source: 'personal',
            pendingSync: false,
          })
        } catch (error) {
          await this.commit({
            ...record,
            pendingSync: true,
            syncError: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })().finally(() => {
      this.update({ syncing: false })
      this.synchronization = null
    })
    return this.synchronization
  }
}

/** Host-supplied scopes include backend and account; no token is used as a cache key. */
export function browserTemplatePersistence(
  scope: string,
  storage: Pick<Storage, 'getItem' | 'setItem'>
) {
  const key = `wegent:collaboration-templates:v1:${encodeURIComponent(scope)}`
  return {
    async read(): Promise<TemplateRecord[]> {
      const raw = storage.getItem(key)
      if (!raw) return []
      const records: unknown = JSON.parse(raw)
      if (!Array.isArray(records)) throw new Error('invalid_template_cache')
      for (const record of records) {
        if (
          !record ||
          typeof record.ownerId !== 'number' ||
          !['personal', 'downloaded'].includes(record.source)
        )
          throw new Error('invalid_template_cache')
        validateTemplate(record.document)
      }
      return records as TemplateRecord[]
    },
    async write(records: TemplateRecord[]): Promise<void> {
      storage.setItem(key, JSON.stringify(records))
    },
  }
}
