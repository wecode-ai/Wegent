import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
})
