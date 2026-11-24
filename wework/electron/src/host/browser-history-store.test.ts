import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
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
  const issueFilters = 'https://tracker.test/issues?code=404&state=open'
  const sas = 'https://files.test/blob?sig=synthetic-secret&se=2027-01-01&sv=2022-11-02&sp=r'
  const loginWithIssue =
    'https://app.test/login?next=' +
    encodeURIComponent('https://tracker.test/issues?state=open&code=404')
  test.each([
    {
      kind: 'credential parameters',
      ordinary: [
        'https://tracker.test/issues?note=missing%20token%3Dexample',
        'https://tracker.test/issues?filter=name%26signature%3Ddraft',
        'https://tracker.test/issues#filter=name%26access_token%3Dexample',
      ],
      sensitive: [
        'https://app.test/redirect?access_token=synthetic-secret',
        'https://app.test/redirect?access_token%3Dsynthetic-secret',
        'https://app.test/redirect#access_token=synthetic-secret',
        'https://app.test/#https://name:synthetic-secret@id.test/login',
        'https://app.test/#' + encodeURIComponent('//name:synthetic-secret@id.test/login'),
        'https://app.test/##https://name:synthetic-secret@id.test/login',
        'https://app.test/redirect?next=' +
          encodeURIComponent(encodeURIComponent('https://id.test/login?token=synthetic-secret')),
        'https://app.test/redirect?next=' +
          encodeURIComponent('https://name:synthetic-secret@id.test/login'),
      ],
    },
    {
      kind: 'Azure SAS',
      sensitive: [
        sas,
        'https://docs.test/?next=' + encodeURIComponent(encodeURIComponent(sas)),
        'https://files.test/#' + encodeURIComponent(new URL(sas).search.slice(1)),
      ],
      ordinary: [
        'https://docs.test/?sig=design',
        'https://docs.test/?sig=design&next=' +
          encodeURIComponent('https://files.test/?sv=1&sp=r&se=2'),
      ],
    },
    {
      kind: 'OAuth code',
      sensitive: [
        'https://app.test/#/oauth/callback?code=synthetic-secret',
        'https://app.test/oauth2callback?code=synthetic-secret&state=opaque',
        'https://app.test/AuthenticationCallback?code=synthetic-secret&state=opaque',
        'https://app.test/login?next=' +
          encodeURIComponent(
            'https://app.test/OAuth2%63allback?code=synthetic-secret&state=opaque'
          ),
        'https://app.test/return?code=synthetic-secret&client_id=demo',
        'https://app.test/return?code=synthetic-secret&iss=https%3A%2F%2Fidentity.test',
      ],
      ordinary: [
        issueFilters,
        'https://tracker.test/orders/return?code=404&state=open',
        'https://tracker.test/orders/finish?code=404&state=open',
        'https://tracker.test/orders/complete?code=404&state=open',
        loginWithIssue,
        'https://docs.test/?next=' + encodeURIComponent(encodeURIComponent(loginWithIssue)),
        issueFilters + '&help=' + encodeURIComponent('https://app.test/callback'),
      ],
    },
  ])(
    'keeps business links and filters $kind on new visits and legacy load',
    async ({ ordinary, sensitive }) => {
      const { path, store } = await createStore()
      const query = { text: '', distinctUrls: true, endTimeMs: null, offset: 0, maxResults: 20 }
      const urls = [...ordinary, ...sensitive]
      await writeFile(
        path,
        JSON.stringify(
          urls.map((url, i) => ({
            id: String(i),
            url,
            title: url,
            visitTimeMs: i,
          }))
        )
      )
      const expected = ordinary.toReversed()
      expect((await store.search(query)).map(entry => entry.url)).toEqual(expected)
      expect(
        JSON.parse(await readFile(path, 'utf8')).map((entry: { url: string }) => entry.url)
      ).toEqual(ordinary)
      for (const url of ordinary) expect(await store.recordVisit(url, 10, url)).toBeTruthy()
      for (const url of sensitive) expect(await store.recordVisit(url, 11, url)).toBeNull()
      await store.recordVisit('https://docs.test/home', 12, sensitive[0]!)
      const reopened = new BrowserHistoryStore(path)
      expect((await reopened.search(query)).map(entry => entry.url)).toEqual([
        'https://docs.test/home',
        ...expected,
      ])
      expect(await readFile(path, 'utf8')).not.toContain('synthetic-secret')
    }
  )

  test('preserves ticket references but excludes authentication tickets on write and migration', async () => {
    const { path, store } = await createStore()
    const issue = 'https://support.test/issue?ticket=SUP-123'
    const cas = 'https://id.test/cas/serviceValidate?ticket=synthetic-receipt'
    const ordinary = [
      issue,
      'https://support.test/issue?ticket=12345',
      issue + '&help=' + encodeURIComponent('https://id.test/login'),
      'https://cas.test/login?service=' + encodeURIComponent(issue),
    ]
    const sensitive = [
      cas,
      'https://identity.test/serviceValidate?ticket=synthetic-receipt',
      'https://product.test/view?ticket=ST-synthetic-service',
      'https://product.test/view?ticket=PT-synthetic-proxy',
      'https://product.test/#/signin?ticket=synthetic-receipt',
      'https://support.test/redirect?next=' + encodeURIComponent(encodeURIComponent(cas)),
    ]
    await writeFile(
      path,
      JSON.stringify(
        [...ordinary, ...sensitive].map((url, i) => ({
          id: String(i),
          visitTimeMs: i,
          url,
          title: url,
        }))
      )
    )
    const query = { text: '', endTimeMs: null, offset: 0, maxResults: 20 }
    expect((await store.search(query)).map(({ url, title }) => [url, title])).toEqual(
      ordinary.toReversed().map(url => [url, url])
    )
    for (const url of ordinary) expect(await store.recordVisit(url, 10, url)).toBeTruthy()
    for (const url of sensitive) await expect(store.recordVisit(url, 11, url)).resolves.toBeNull()
    await store.recordVisit('https://support.test/home', 12, encodeURIComponent(cas))
    expect(await store.search({ ...query, text: 'SUP-123' })).toHaveLength(6)
    expect(await readFile(path, 'utf8')).not.toContain('synthetic-')
  })

  test('can read safe visits when the old history file cannot yet be rewritten', async () => {
    const { path, store } = await createStore()
    const ordinary = { id: '1', url: 'https://docs.test/', visitTimeMs: 10, title: null }
    await writeFile(
      path,
      JSON.stringify([
        ordinary,
        { ...ordinary, id: '2', url: 'https://app.test/#id_token=synthetic-secret' },
      ])
    )
    await mkdir(`${path}.tmp`)
    await expect(
      store.search({ text: '', endTimeMs: null, offset: 0, maxResults: 10 })
    ).resolves.toEqual([ordinary])
    await rmdir(`${path}.tmp`)
    await store.recordVisit('https://docs.test/news', 15, 'News')
    expect(await readFile(path, 'utf8')).not.toContain('synthetic-secret')
  })

  test('drops credential-bearing visits and cleans older records before searching or paginating', async () => {
    const { path, store } = await createStore()
    const callback = 'https://app.test/login/oidc?access_token=history-test-secret'
    const ordinary = 'https://docs.test/articles?topic=oauth#token-format'
    const visit = (id: string, url: string, title: string) => ({ id, url, title, visitTimeMs: 10 })
    await writeFile(
      path,
      JSON.stringify([
        visit('safe', ordinary, 'Docs'),
        visit('legacy', callback, 'Docs login'),
        visit('old-title', 'https://app.test/home', callback),
      ])
    )
    const query = { text: '', endTimeMs: null, offset: 0, maxResults: 1 }
    await expect(store.search(query)).resolves.toMatchObject([{ id: 'old-title', title: null }])
    await expect(store.search({ ...query, offset: 1 })).resolves.toMatchObject([{ id: 'safe' }])
    await expect(store.search({ ...query, text: 'history-test-secret' })).resolves.toEqual([])
    expect(await readFile(path, 'utf8')).not.toContain('history-test-secret')

    for (const url of [
      callback,
      'https://name:history-test-secret@app.test/',
      'https://app.test/#/login?refresh_token=history-test-secret',
      'https://app.test/callback?code=history-test-secret',
      'https://app.test/finish?iss=https%3A%2F%2Fidentity.test&code=history-test-secret',
      'https://cas.test/login?service=' + encodeURIComponent(encodeURIComponent(callback)),
    ]) {
      await expect(store.recordVisit(url, 20, 'Docs')).resolves.toBeNull()
    }
    await store.backfillTitle('old-title', callback)
    await store.recordVisit('https://docs.test/?code=404', 30, 'HTTP codes')
    expect(await readFile(path, 'utf8')).not.toContain('history-test-secret')
    const entries = await store.search({ ...query, distinctUrls: true, maxResults: 10 })
    expect(entries.map(entry => entry.url)).toEqual([
      'https://docs.test/?code=404',
      'https://app.test/home',
      ordinary,
    ])
  })

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

  test('limits distinct suggestions after matching visits and keeps the newest matching title', async () => {
    const { store } = await createStore()
    await store.recordVisit('https://other.test', 1, 'Docs overview')
    await store.recordVisit('https://docs.test', 2, 'First title')
    await store.recordVisit('https://docs.test', 3, 'Latest title')
    const query = { text: 'DOCS', endTimeMs: null, offset: 0, maxResults: 2 }
    await expect(store.search({ ...query, distinctUrls: true })).resolves.toMatchObject([
      { url: 'https://docs.test', title: 'Latest title' },
      { url: 'https://other.test' },
    ])
    await expect(store.search(query)).resolves.toMatchObject([
      { title: 'Latest title' },
      { title: 'First title' },
    ])
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
