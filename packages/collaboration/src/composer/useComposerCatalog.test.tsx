// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { useComposerCatalog, type ComposerCatalogStore } from './useComposerCatalog'

type App = { id: string; name: string; isEnabled?: boolean }
const events = {}
const isMenuOpen = () => true
function createStore() {
  let apps: App[] = []
  const listeners = new Set<() => void>()
  const store: ComposerCatalogStore<App> = {
    get: () => apps,
    readSnapshot: () => apps,
    publish(next) {
      apps = next
      listeners.forEach(listener => listener())
    },
    replace(next) {
      apps = next
      listeners.forEach(listener => listener())
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    suppressSync: () => false,
  }
  return store
}

describe('shared composer catalog lifecycle', () => {
  let root: Root
  let container: HTMLDivElement
  let current: ReturnType<typeof useComposerCatalog<string, App>>
  let store: ComposerCatalogStore<App>
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    store = createStore()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  function Harness({
    apps,
    skills,
  }: {
    apps: () => Promise<App[]>
    skills?: () => Promise<string[]>
  }) {
    const catalog = useComposerCatalog({
      onListLocalApps: apps,
      onListLocalSkills: skills,
      appsStore: store,
      events,
      isMenuOpen,
    })
    useEffect(() => {
      current = catalog
    }, [catalog])
    return <div>{catalog.apps.map(app => `${app.name}:${app.isEnabled}`).join(',')}</div>
  }
  async function mount(apps: () => Promise<App[]>, skills?: () => Promise<string[]>) {
    await act(async () => root.render(<Harness apps={apps} skills={skills} />))
  }

  it('clears the previous task and rejects its pending response when the store changes', async () => {
    let resolveOld!: (apps: App[]) => void
    const oldStore = store
    store.replace([{ id: 'old', name: 'Old task' }])
    const oldApps = vi.fn(
      () =>
        new Promise<App[]>(resolve => {
          resolveOld = resolve
        })
    )
    await mount(oldApps, async () => ['old skill'])
    await act(async () => current.loadLocalMentions())
    expect(current.skills).toEqual(['old skill'])
    store = createStore()
    const newApps = vi.fn().mockResolvedValue([{ id: 'new', name: 'New task' }])
    await mount(newApps, async () => ['new skill'])
    expect(current.apps).toEqual([])
    expect(current.skills).toEqual([])
    await act(async () => resolveOld([{ id: 'late-old', name: 'Old response' }]))
    expect(store.get()).toEqual([])
    expect(oldStore.get()).toEqual([{ id: 'old', name: 'Old task' }])
    await act(async () => current.loadLocalMentions())
    expect(current.apps).toEqual([{ id: 'new', name: 'New task' }])
    expect(current.skills).toEqual(['new skill'])
  })

  it('refreshes metadata and accessibility when an installed app keeps its ID', async () => {
    const apps = vi.fn().mockResolvedValue([{ id: 'plugin', name: 'Old name', isEnabled: true }])
    await mount(apps)
    await act(async () => current.loadLocalMentions())
    expect(container.textContent).toBe('Old name:true')
    await act(async () => store.publish([{ id: 'plugin', name: 'New name', isEnabled: false }]))
    expect(container.textContent).toBe('New name:false')
    expect(apps).toHaveBeenCalledTimes(1)
  })

  it('exposes failed catalogs and retries only when explicitly requested', async () => {
    const apps = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce([{ id: 'plugin', name: 'Plugin' }])
    const skills = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce(['skill'])
    await mount(apps, skills)
    await act(async () => current.loadLocalMentions())
    expect(current).toMatchObject({
      loadError: true,
      appsLoadError: true,
      loading: false,
      appsLoading: false,
    })
    await act(async () => current.loadLocalMentions())
    expect(apps).toHaveBeenCalledTimes(1)
    expect(skills).toHaveBeenCalledTimes(1)
    await act(async () => current.loadLocalMentions({ force: true }))
    expect(current).toMatchObject({
      loadError: false,
      appsLoadError: false,
      skills: ['skill'],
      apps: [{ id: 'plugin', name: 'Plugin' }],
    })
  })

  it('ignores an old loader response after switching the catalog source', async () => {
    let finishOld!: (apps: App[]) => void
    const oldApps = vi.fn(
      () =>
        new Promise<App[]>(resolve => {
          finishOld = resolve
        })
    )
    const newApps = vi.fn().mockResolvedValue([{ id: 'new', name: 'New source' }])
    await mount(oldApps)
    await act(async () => current.loadLocalMentions())
    await mount(newApps)
    await act(async () => current.loadLocalMentions())
    await act(async () => finishOld([{ id: 'old', name: 'Old source' }]))
    expect(container.textContent).toBe('New source:undefined')
    expect(store.get()).toEqual([{ id: 'new', name: 'New source' }])
  })

  it('clears cached plugins when the authoritative catalog becomes empty', async () => {
    store.replace([{ id: 'plugin', name: 'Previously installed' }])
    await mount(vi.fn().mockResolvedValue([]))
    await act(async () => current.loadLocalMentions({ force: true }))
    expect(current.apps).toEqual([])
    expect(store.get()).toEqual([])
    expect(current.appsLoading).toBe(false)
  })

  it('does not resurrect an uninstalled plugin from an in-flight response', async () => {
    store.replace([{ id: 'plugin', name: 'Installed' }])
    let finish!: (apps: App[]) => void
    await mount(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    await act(async () => current.loadLocalMentions({ force: true }))
    await act(async () => store.replace([]))
    await act(async () => finish([{ id: 'plugin', name: 'Stale installed' }]))
    expect(current.apps).toEqual([])
    expect(store.get()).toEqual([])
  })
})
