import { expect, test, vi } from 'vitest'
import { createComposerCatalogResource } from './composerCatalogResource'
import { createComposerCatalogStore } from './createComposerCatalogStore'

type App = { id: string; name: string }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}
function fixture() {
  const store = createComposerCatalogStore<App>()
  const skills = vi.fn<() => Promise<string[]>>().mockResolvedValue(['review'])
  const apps = vi.fn<() => Promise<App[]>>().mockResolvedValue([{ id: 'tool', name: 'Tool' }])
  const resource = createComposerCatalogResource({
    appsStore: store,
    onListLocalSkills: skills,
    onListLocalApps: apps,
  })
  return { store, skills, apps, resource }
}

test('subscribes to cached metadata without reading unopened catalogs', () => {
  const f = fixture()
  const stop = f.resource.subscribe(vi.fn())
  expect(f.skills).not.toHaveBeenCalled()
  expect(f.apps).not.toHaveBeenCalled()
  expect(f.resource.getSnapshot()).toMatchObject({
    apps: [],
    skills: [],
    loading: false,
    appsLoading: false,
  })
  stop()
})

test('publishes skill failures independently of a pending app catalog', async () => {
  const f = fixture(),
    pending = deferred<App[]>()
  f.skills.mockRejectedValue(new Error('Skills offline'))
  f.apps.mockReturnValue(pending.promise)
  const stop = f.resource.subscribe(vi.fn())
  f.resource.loadLocalMentions()
  await vi.waitFor(() =>
    expect(f.resource.getSnapshot()).toMatchObject({
      loadError: true,
      loading: false,
      appsLoading: true,
    })
  )
  pending.resolve([{ id: 'remote', name: 'Remote Tool' }])
  await vi.waitFor(() =>
    expect(f.resource.getSnapshot()).toMatchObject({
      loadError: true,
      appsLoading: false,
      apps: [{ id: 'remote', name: 'Remote Tool' }],
    })
  )
  stop()
})

test('coalesces ordinary reads and retries successful catalogs only on an explicit force', async () => {
  const f = fixture()
  const stop = f.resource.subscribe(vi.fn())
  f.resource.loadLocalMentions()
  f.resource.loadLocalMentions()
  await vi.waitFor(() => expect(f.resource.getSnapshot().skills).toEqual(['review']))
  f.resource.loadLocalMentions()
  expect(f.apps).toHaveBeenCalledTimes(1)
  expect(f.skills).toHaveBeenCalledTimes(1)
  f.skills.mockResolvedValue(['new skill'])
  f.resource.loadLocalMentions({ force: true })
  await vi.waitFor(() => expect(f.resource.getSnapshot().skills).toEqual(['new skill']))
  expect(f.skills).toHaveBeenCalledTimes(2)
  expect(f.apps).toHaveBeenCalledTimes(2)
  stop()
})

test('ignores both superseded app and skill responses after a forced refresh', async () => {
  const f = fixture(),
    oldApps = deferred<App[]>(),
    oldSkills = deferred<string[]>()
  f.apps.mockReturnValueOnce(oldApps.promise)
  f.skills.mockReturnValueOnce(oldSkills.promise)
  const stop = f.resource.subscribe(vi.fn())
  f.resource.loadLocalMentions()
  f.resource.loadLocalMentions({ force: true })
  await vi.waitFor(() => expect(f.resource.getSnapshot().skills).toEqual(['review']))
  oldApps.resolve([{ id: 'old', name: 'Old app' }])
  oldSkills.resolve(['old skill'])
  await oldApps.promise
  await oldSkills.promise
  expect(f.resource.getSnapshot()).toMatchObject({
    apps: [{ id: 'tool', name: 'Tool' }],
    skills: ['review'],
  })
  expect(f.store.get()).toEqual([{ id: 'tool', name: 'Tool' }])
  stop()
})

test('preserves same-source app metadata on failure and makes empty success authoritative', async () => {
  const f = fixture()
  f.store.replace([{ id: 'cached', name: 'Cached app' }])
  f.apps.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce([])
  const stop = f.resource.subscribe(vi.fn())
  f.resource.loadLocalMentions({ force: true })
  await vi.waitFor(() => expect(f.resource.getSnapshot().appsLoadError).toBe(true))
  expect(f.resource.getSnapshot().apps).toEqual([{ id: 'cached', name: 'Cached app' }])
  f.resource.loadLocalMentions()
  expect(f.apps).toHaveBeenCalledTimes(1)
  f.resource.loadLocalMentions({ force: true })
  await vi.waitFor(() =>
    expect(f.resource.getSnapshot()).toMatchObject({
      appsLoadError: false,
      appsLoading: false,
      apps: [],
    })
  )
  expect(f.store.get()).toEqual([])
  stop()
})

test('does not resurrect removed apps after an authoritative store update', async () => {
  const f = fixture(),
    pending = deferred<App[]>()
  f.apps.mockReturnValue(pending.promise)
  const stop = f.resource.subscribe(vi.fn())
  f.resource.loadLocalMentions()
  f.store.replace([])
  pending.resolve([{ id: 'removed', name: 'Removed app' }])
  await pending.promise
  expect(f.resource.getSnapshot()).toMatchObject({
    apps: [],
    appsLoading: false,
  })
  expect(f.store.get()).toEqual([])
  stop()
})

test('invalidates skills without fetching them while their menu is closed', async () => {
  const f = fixture()
  const stop = f.resource.subscribe(vi.fn())
  f.resource.loadLocalMentions()
  await vi.waitFor(() => expect(f.resource.getSnapshot().skills).toEqual(['review']))
  f.skills.mockResolvedValue(['new skill'])
  f.apps.mockResolvedValue([{ id: 'new', name: 'New app' }])
  f.resource.invalidate(false)
  expect(f.resource.getSnapshot().skills).toEqual([])
  expect(f.skills).toHaveBeenCalledTimes(1)
  await vi.waitFor(() =>
    expect(f.resource.getSnapshot().apps).toEqual([{ id: 'new', name: 'New app' }])
  )
  f.resource.loadLocalMentions()
  await vi.waitFor(() => expect(f.resource.getSnapshot().skills).toEqual(['new skill']))
  stop()
})

test('does not publish late reads to the host store after the composer detaches', async () => {
  const f = fixture(),
    pending = deferred<App[]>(),
    pendingSkills = deferred<string[]>()
  f.apps.mockReturnValue(pending.promise)
  f.skills.mockReturnValue(pendingSkills.promise)
  const stop = f.resource.subscribe(vi.fn())
  f.resource.loadLocalMentions()
  stop()
  pending.resolve([{ id: 'late', name: 'Late app' }])
  pendingSkills.resolve(['late skill'])
  await pending.promise
  await pendingSkills.promise
  expect(f.store.get()).toEqual([])
  expect(f.resource.getSnapshot()).toMatchObject({
    apps: [],
    skills: [],
    loading: false,
    appsLoading: false,
  })
  f.resource.loadLocalMentions({ force: true })
  expect(f.apps).toHaveBeenCalledTimes(1)
  expect(f.skills).toHaveBeenCalledTimes(1)
})

test('synchronizes a committed app list without bypassing the host suppression contract', async () => {
  const f = fixture()
  const publish = vi.spyOn(f.store, 'publish')
  const suppressed = vi.spyOn(f.store, 'suppressSync').mockReturnValue(false)
  const stop = f.resource.subscribe(vi.fn())
  f.resource.publishApps()
  expect(publish).not.toHaveBeenCalled()
  f.store.replace([{ id: 'cached', name: 'Cached app' }])
  f.resource.publishApps()
  expect(publish).toHaveBeenCalledTimes(1)
  suppressed.mockReturnValue(true)
  f.resource.publishApps()
  expect(publish).toHaveBeenCalledTimes(1)
  stop()
})
