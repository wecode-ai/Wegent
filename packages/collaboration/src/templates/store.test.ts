import { describe, expect, it, vi } from 'vitest'
import { CollaborationTemplateStore, browserTemplatePersistence } from './store'
import { builtinCollaborationTemplates } from './builtins'
import type { CollaborationTemplateRemote, TemplateRecord } from './types'

function persistence() {
  let records: TemplateRecord[] = []
  return {
    read: vi.fn(async () => structuredClone(records)),
    write: vi.fn(async (next: TemplateRecord[]) => {
      records = structuredClone(next)
    }),
  }
}

function personal(name = 'personal-template') {
  const document = structuredClone(builtinCollaborationTemplates()[0].document)
  document.metadata = { name, namespace: 'default' }
  return document
}

function remote(): CollaborationTemplateRemote {
  return {
    list: vi.fn(async () => []),
    discover: vi.fn(async () => ({
      items: [],
      hasMore: false,
      nextCursor: null,
    })),
    get: vi.fn(),
    install: vi.fn(),
    publish: vi.fn(),
    save: vi.fn(async document => ({
      id: 42,
      ownerId: 7,
      document,
      source: 'personal',
      revision: '1',
    })),
  }
}

describe('scoped template store', () => {
  it('drains drafts saved while another synchronization is in progress', async () => {
    const backend = remote()
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    vi.mocked(backend.save).mockImplementationOnce(async document => {
      await held
      return { id: 41, ownerId: 7, document, source: 'personal', revision: '1' }
    })
    const store = new CollaborationTemplateStore({
      scope: 'backend:7',
      ownerId: 7,
      persistence: persistence(),
      remote: backend,
    })
    const first = store.save(personal('first-draft'), 7)
    await vi.waitFor(() => expect(backend.save).toHaveBeenCalledTimes(1))
    const second = store.save(personal('second-draft'), 7)
    await vi.waitFor(() =>
      expect(store.getSnapshot().records.filter(record => record.pendingSync)).toHaveLength(2)
    )
    release()
    await Promise.all([first, second])
    expect(backend.save).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().records.some(record => record.pendingSync)).toBe(false)
  })
  it('makes builtins available before any backend request or cache read finishes', async () => {
    const store = new CollaborationTemplateStore({
      scope: 'backend:7',
      ownerId: 7,
      persistence: persistence(),
    })
    expect(store.getSnapshot().records).toHaveLength(3)
    await store.load()
    expect(store.getSnapshot().records.every(record => record.source === 'builtin')).toBe(true)
  })

  it('persists offline drafts and syncs them once without implicitly publishing', async () => {
    const cache = persistence()
    const offline = new CollaborationTemplateStore({
      scope: 'backend:7',
      ownerId: 7,
      persistence: cache,
    })
    await offline.save(personal(), 7)
    expect(
      offline.getSnapshot().records.find(record => record.source === 'personal')?.pendingSync
    ).toBe(true)
    const backend = remote()
    const online = new CollaborationTemplateStore({
      scope: 'backend:7',
      ownerId: 7,
      persistence: cache,
      remote: backend,
    })
    await Promise.all([online.synchronize(), online.synchronize()])
    expect(backend.save).toHaveBeenCalledTimes(1)
    expect(backend.publish).not.toHaveBeenCalled()
    expect(online.getSnapshot().records.find(record => record.id === 42)?.pendingSync).toBe(false)
    expect(online.getSnapshot().records.find(record => record.id === 42)?.revision).toBe('1')
  })

  it('preserves conflicting drafts and never overwrites the server source', async () => {
    const backend = remote()
    vi.mocked(backend.save).mockRejectedValue(new Error('HTTP 409'))
    const store = new CollaborationTemplateStore({
      scope: 'backend:7',
      ownerId: 7,
      persistence: persistence(),
      remote: backend,
    })
    await store.save(personal(), 7)
    const draft = store.getSnapshot().records.find(record => record.source === 'personal')!
    expect(draft.pendingSync).toBe(true)
    expect(draft.syncError).toBe('HTTP 409')
    expect(backend.save).toHaveBeenCalledWith(draft.document, null)
  })

  it('does not download or erase a pending local edit of the same source', async () => {
    const cache = persistence()
    const backend = remote()
    const offline = new CollaborationTemplateStore({
      scope: 'backend:7',
      ownerId: 7,
      persistence: cache,
    })
    await offline.save(personal(), 7)
    vi.mocked(backend.get).mockResolvedValue({
      id: 42,
      ownerId: 7,
      document: personal(),
      revision: '1',
      source: 'downloaded',
    })
    const online = new CollaborationTemplateStore({
      scope: 'backend:7',
      ownerId: 7,
      persistence: cache,
      remote: backend,
    })
    await expect(online.download(42)).rejects.toThrow('pending_template_conflict')
    expect(
      online.getSnapshot().records.find(record => record.source === 'personal')?.pendingSync
    ).toBe(true)
  })

  it('isolates backend and account caches and rejects a cross-account personal record', async () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
    const first = browserTemplatePersistence('backend-a:7', storage)
    await first.write([
      {
        id: null,
        ownerId: 7,
        document: personal(),
        revision: null,
        source: 'personal',
        pendingSync: true,
      },
    ])
    expect(await browserTemplatePersistence('backend-b:7', storage).read()).toEqual([])
    expect(await browserTemplatePersistence('backend-a:8', storage).read()).toEqual([])
    const wrongAccount = new CollaborationTemplateStore({
      scope: 'backend-a:8',
      ownerId: 8,
      persistence: first,
    })
    await expect(wrongAccount.load()).rejects.toThrow('invalid_template_scope')
    expect(wrongAccount.getSnapshot().records.every(record => record.source === 'builtin')).toBe(
      true
    )
  })
})
