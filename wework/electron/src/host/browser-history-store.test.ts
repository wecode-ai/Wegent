import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { BrowserHistoryStore } from './browser-history-store.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function createStore(): Promise<{ path: string; store: BrowserHistoryStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'wework-browser-history-'))
  directories.push(directory)
  const path = join(directory, 'browser-history.json')
  return { path, store: new BrowserHistoryStore(path) }
}

describe('BrowserHistoryStore', () => {
  test('persists visits and searches newest first by URL or title', async () => {
    const { path, store } = await createStore()
    await store.recordVisit('https://docs.example/rust', 1_000, 'Rust Book')
    await store.recordVisit('https://other.example', 2_000, '')

    await expect(
      store.search({ text: 'RUST', endTimeMs: null, offset: 0, maxResults: 100 })
    ).resolves.toMatchObject([{ url: 'https://docs.example/rust', title: 'Rust Book' }])
    await expect(
      store.search({ text: '  ', endTimeMs: null, offset: 0, maxResults: 100 })
    ).resolves.toMatchObject([
      { url: 'https://other.example', title: null },
      { url: 'https://docs.example/rust', title: 'Rust Book' },
    ])
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(2)
  })

  test('preserves cursor offset semantics for visits in the same millisecond', async () => {
    const { store } = await createStore()
    await store.recordVisit('https://example.test/1', 1_000, null)
    await store.recordVisit('https://example.test/2', 1_000, null)
    await store.recordVisit('https://example.test/3', 1_000, null)

    const firstPage = await store.search({
      text: '',
      endTimeMs: null,
      offset: 0,
      maxResults: 2,
    })
    expect(firstPage.map(entry => entry.url)).toEqual([
      'https://example.test/3',
      'https://example.test/2',
    ])
    await expect(
      store.search({ text: '', endTimeMs: 1_001, offset: 2, maxResults: 2 })
    ).resolves.toMatchObject([{ url: 'https://example.test/1' }])
  })

  test('loads sorted persisted entries and removes only selected ids', async () => {
    const { path } = await createStore()
    await writeFile(
      path,
      JSON.stringify([
        { id: 'new', url: 'https://new.example', title: null, visitTimeMs: 2_000 },
        { id: 'old', url: 'https://old.example', title: null, visitTimeMs: 1_000 },
      ])
    )
    const store = new BrowserHistoryStore(path)

    await expect(
      store.search({ text: '', endTimeMs: null, offset: 0, maxResults: 100 })
    ).resolves.toMatchObject([{ id: 'new' }, { id: 'old' }])
    await expect(store.remove(['old'])).resolves.toBe(1)
    await expect(
      store.search({ text: '', endTimeMs: null, offset: 0, maxResults: 100 })
    ).resolves.toMatchObject([{ id: 'new' }])
  })
})
