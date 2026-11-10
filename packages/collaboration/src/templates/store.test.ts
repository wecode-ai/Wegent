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
    delete: vi.fn(),
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
  it('deletes offline imports durably and keeps builtins', async () => {
    const cache = persistence()
    const store = new CollaborationTemplateStore({
      scope: 'local:7',
      ownerId: 7,
      persistence: cache,
    })
    const record = await store.save(personal(), 7)
    await store.delete(record)
    expect(await cache.read()).toEqual([])
    const reloaded = new CollaborationTemplateStore({
      scope: 'local:7',
      ownerId: 7,
      persistence: cache,
    })
    await reloaded.load()
    expect(reloaded.getSnapshot().records.every(item => item.source === 'builtin')).toBe(true)
  })

  it('keeps synced templates on remote failure and allows retry', async () => {
    const backend = remote()
    const cache = persistence()
    const store = new CollaborationTemplateStore({
      scope: 'backend:7',
      ownerId: 7,
      remote: backend,
      persistence: cache,
    })
    const record = await store.save(personal(), 7)
    vi.mocked(backend.delete).mockRejectedValueOnce(new Error('offline'))
    await expect(store.delete(record)).rejects.toThrow('offline')
    expect(await cache.read()).toHaveLength(1)
    await store.delete(record)
    expect(backend.delete).toHaveBeenLastCalledWith(42)
    expect(await cache.read()).toEqual([])
  })

  it('rejects builtin, downloaded and cross-account deletion', async () => {
    const backend = remote()
    const store = new CollaborationTemplateStore({
      scope: 'backend:7',
      ownerId: 7,
      remote: backend,
      persistence: persistence(),
    })
    for (const record of [
      builtinCollaborationTemplates()[0],
      {
        id: 42,
        ownerId: 8,
        source: 'personal' as const,
        document: personal(),
        revision: '1',
      },
      {
        id: 42,
        ownerId: 7,
        source: 'downloaded' as const,
        document: personal(),
        revision: '1',
      },
    ])
      await expect(store.delete(record)).rejects.toThrow('invalid_template_scope')
    expect(backend.delete).not.toHaveBeenCalled()
  })

  it('waits for synchronization before deleting the assigned server id', async () => {
    const backend = remote()
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    vi.mocked(backend.save).mockImplementationOnce(async document => {
      await held
      return {
        id: 42,
        ownerId: 7,
        document,
        source: 'personal',
        revision: '1',
      }
    })
    const cache = persistence()
    const store = new CollaborationTemplateStore({
      scope: 'backend:7',
      ownerId: 7,
      remote: backend,
      persistence: cache,
    })
    const saving = store.save(personal(), 7)
    await vi.waitFor(() => expect(backend.save).toHaveBeenCalledOnce())
    const draft = store.getSnapshot().records.find(item => item.pendingSync)!
    const deleting = store.delete(draft)
    release()
    await Promise.all([saving, deleting])
    expect(backend.delete).toHaveBeenCalledWith(42)
    expect(await cache.read()).toEqual([])
  })

  it('requires a connection to delete a synced template', async () => {
    const cache = persistence()
    const online = new CollaborationTemplateStore({
      scope: 'backend:7',
      ownerId: 7,
      remote: remote(),
      persistence: cache,
    })
    const record = await online.save(personal(), 7)
    const offline = new CollaborationTemplateStore({
      scope: 'backend:7',
      ownerId: 7,
      persistence: cache,
    })
    await expect(offline.delete(record)).rejects.toThrow('connection_required')
    expect(await cache.read()).toHaveLength(1)
  })

  it('retries an idempotent cloud deletion when local persistence failed', async () => {
    const backend = remote()
    const cache = persistence()
    const store = new CollaborationTemplateStore({
      scope: 'backend:7',
      ownerId: 7,
      remote: backend,
      persistence: cache,
    })
    const record = await store.save(personal(), 7)
    cache.write.mockRejectedValueOnce(new Error('disk full'))
    await expect(store.delete(record)).rejects.toThrow('disk full')
    expect(store.getSnapshot().records).toContainEqual(record)
    await store.delete(record)
    expect(await cache.read()).toEqual([])
    expect(backend.delete).toHaveBeenCalledTimes(2)
  })
  it('downloads an account reference without reinstalling a withdrawn template', async () => {
    const backend = remote()
    const document = personal('installed-workflow')
    vi.mocked(backend.get).mockResolvedValue({
      id: 42,
      ownerId: 8,
      document,
      revision: '1',
      source: 'downloaded',
    })
    vi.mocked(backend.list).mockResolvedValue([
      {
        id: 42,
        ownerId: 8,
        namespace: 'default',
        name: document.metadata.name,
        displayName: document.spec.displayName,
        description: '',
        version: '1.0.0',
        revision: '1',
      },
    ])
    vi.mocked(backend.install).mockRejectedValue(new Error('Publication withdrawn'))
    const store = new CollaborationTemplateStore({
      scope: 'backend:7',
      ownerId: 7,
      persistence: persistence(),
      remote: backend,
    })
    await expect(store.download(42)).resolves.toMatchObject({
      id: 42,
      pendingSync: false,
    })
    expect(backend.install).not.toHaveBeenCalled()
    expect(backend.get).toHaveBeenCalledTimes(2)
  })
  it('drains drafts saved while another synchronization is in progress', async () => {
    const backend = remote()
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    vi.mocked(backend.save).mockImplementationOnce(async document => {
      await held
      return {
        id: 41,
        ownerId: 7,
        document,
        source: 'personal',
        revision: '1',
      }
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
