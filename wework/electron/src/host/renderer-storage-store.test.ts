import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RendererStorageStore } from './renderer-storage-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createStore(): Promise<{ root: string; store: RendererStorageStore }> {
  const root = await mkdtemp(join(tmpdir(), 'wework-renderer-storage-'))
  roots.push(root)
  return { root, store: new RendererStorageStore(root) }
}

describe('RendererStorageStore', () => {
  it('preserves browser storage until a durable snapshot exists', async () => {
    const { store } = await createStore()
    const cleanup = {
      clearAll: vi.fn(async () => undefined),
      clearOrigin: vi.fn(async () => undefined),
    }

    await store.prepareOrigin('http://127.0.0.1:4101', cleanup)

    expect(cleanup.clearAll).not.toHaveBeenCalled()
    expect(cleanup.clearOrigin).not.toHaveBeenCalled()
  })

  it('clears legacy browser storage once and later clears only the previous origin', async () => {
    const { root, store } = await createStore()
    const cleanup = {
      clearAll: vi.fn(async () => undefined),
      clearOrigin: vi.fn(async () => undefined),
    }
    await store.initialize({ appearance: 'dark' })

    await store.prepareOrigin('http://127.0.0.1:4101', cleanup)

    expect(cleanup.clearAll).toHaveBeenCalledOnce()
    expect(cleanup.clearOrigin).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'renderer-local-storage-origins.json'), 'utf8')).toBe(
      '{"version":1,"origins":["http://127.0.0.1:4101"]}\n'
    )

    cleanup.clearAll.mockClear()
    await store.prepareOrigin('http://127.0.0.1:4102', cleanup)

    expect(cleanup.clearAll).not.toHaveBeenCalled()
    expect(cleanup.clearOrigin).toHaveBeenCalledWith('http://127.0.0.1:4101')
    expect(await readFile(join(root, 'renderer-local-storage-origins.json'), 'utf8')).toBe(
      '{"version":1,"origins":["http://127.0.0.1:4102"]}\n'
    )

    cleanup.clearOrigin.mockClear()
    await store.prepareOrigin('http://127.0.0.1:4102', cleanup)
    expect(cleanup.clearOrigin).not.toHaveBeenCalled()
  })

  it('treats an empty origin list as legacy browser storage', async () => {
    const { root, store } = await createStore()
    const cleanup = {
      clearAll: vi.fn(async () => undefined),
      clearOrigin: vi.fn(async () => undefined),
    }
    await store.initialize({ appearance: 'dark' })
    await writeFile(
      join(root, 'renderer-local-storage-origins.json'),
      '{"version":1,"origins":[]}\n'
    )

    await store.prepareOrigin('http://127.0.0.1:4101', cleanup)

    expect(cleanup.clearAll).toHaveBeenCalledOnce()
    expect(cleanup.clearOrigin).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'renderer-local-storage-origins.json'), 'utf8')).toBe(
      '{"version":1,"origins":["http://127.0.0.1:4101"]}\n'
    )
  })

  it('seeds the durable store once and restores it on later origins', async () => {
    const { root, store } = await createStore()

    await expect(store.initialize({ appearance: 'dark', proxy: 'first' })).resolves.toEqual({
      appearance: 'dark',
      proxy: 'first',
    })
    await expect(
      new RendererStorageStore(root).initialize({ appearance: 'light', stale: 'value' })
    ).resolves.toEqual({
      appearance: 'dark',
      proxy: 'first',
    })
  })

  it('serializes updates, removals, and clears', async () => {
    const { root, store } = await createStore()
    await store.initialize({ first: 'one', removed: 'old' })

    await Promise.all([
      store.update({ clear: false, changes: { first: 'updated', second: 'two' } }),
      store.update({ clear: false, changes: { removed: null } }),
      store.update({ clear: true, changes: { final: 'value' } }),
    ])

    await expect(new RendererStorageStore(root).initialize({})).resolves.toEqual({
      final: 'value',
    })
    expect(await readFile(join(root, 'renderer-local-storage.json'), 'utf8')).toBe(
      '{"version":1,"entries":{"final":"value"}}\n'
    )
  })

  it('persists prototype-shaped keys as ordinary entries', async () => {
    const { root, store } = await createStore()
    const changes = JSON.parse('{"__proto__":"safe","constructor":"value"}') as Record<
      string,
      string
    >

    await store.update({ clear: true, changes })

    await expect(new RendererStorageStore(root).initialize({})).resolves.toEqual(changes)
    expect(await readFile(join(root, 'renderer-local-storage.json'), 'utf8')).toBe(
      '{"version":1,"entries":{"__proto__":"safe","constructor":"value"}}\n'
    )
  })

  it('removes only matching recovery prefixes', async () => {
    const { root, store } = await createStore()
    await store.initialize({
      auth_token: 'preserved-token',
      appearance: 'dark',
      'wework:workbench-split-groups:v3:fixed-task': 'stale-layout',
      'wework.workspaceTabs.v3:workspace-1': 'stale-tabs',
    })

    await store.removeByPrefixes(['wework:workbench-split-groups:', 'wework.workspaceTabs.v3:'])

    await expect(new RendererStorageStore(root).initialize({})).resolves.toEqual({
      auth_token: 'preserved-token',
      appearance: 'dark',
    })
  })

  it('clears all renderer application state', async () => {
    const { root, store } = await createStore()
    await store.initialize({ auth_token: 'token', appearance: 'dark' })

    await store.clear()

    await expect(new RendererStorageStore(root).initialize({})).resolves.toEqual({})
  })
})
