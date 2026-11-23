import { createAsyncResource } from '@wegent/chat-core/async-resource'

export interface ComposerCatalogStore<App> {
  get(): App[]
  readSnapshot(): App[]
  publish(apps: App[]): void
  replace(apps: App[]): void
  subscribe(listener: () => void): () => void
  suppressSync(): boolean
}
export interface ComposerCatalogEvents {
  requestSync?: string
  catalogChanged?: string
}
export interface ComposerCatalogSources<Skill, App> {
  onListLocalSkills?: () => Promise<Skill[]>
  onListLocalApps?: () => Promise<App[]>
  appsStore: ComposerCatalogStore<App>
}
interface CatalogSnapshot<Skill, App> {
  skills: Skill[]
  apps: App[]
  loading: boolean
  loadError: boolean
  appsLoading: boolean
  appsLoadError: boolean
}

/** A mounted composer owns lazy reads; the host store owns authoritative app updates. */
export function createComposerCatalogResource<Skill, App>(
  { appsStore, onListLocalApps, onListLocalSkills }: ComposerCatalogSources<Skill, App>,
  initiallyLoad = false
) {
  const listeners = new Set<() => void>()
  let snapshot: CatalogSnapshot<Skill, App> = {
    skills: [],
    apps: appsStore.readSnapshot(),
    loading: false,
    loadError: false,
    appsLoading: false,
    appsLoadError: false,
  }
  let stopStore: (() => void) | undefined
  let stopApps: (() => void) | undefined
  let stopSkills: (() => void) | undefined
  let externalAppsReady = false
  let skillsInvalidated = false
  const publish = (patch: Partial<CatalogSnapshot<Skill, App>>) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const skills = createAsyncResource('composer/skills', () => onListLocalSkills!())
  const createApps = () =>
    createAsyncResource('composer/apps', () => onListLocalApps!(), {
      initialData: snapshot.apps,
      success: data => appsStore.replace(data),
    })
  let apps: ReturnType<typeof createApps> | undefined
  const readSkills = () => {
    const state = skills.getSnapshot()
    publish({
      skills: state.data ?? [],
      loading: state.status === 'loading',
      loadError: state.status === 'error',
    })
  }
  const readApps = () => {
    const state = apps!.getSnapshot()
    publish({
      apps: state.data ?? [],
      appsLoading: state.status === 'loading',
      appsLoadError: state.status === 'error',
    })
  }
  const loadLocalSkills = (options?: { force?: boolean }) => {
    if (!listeners.size || !onListLocalSkills) return
    const force = options?.force || skillsInvalidated
    skillsInvalidated = false
    if (!stopSkills) stopSkills = skills.subscribe(readSkills)
    else if (force || skills.getSnapshot().status === 'idle') void skills.reload()
  }
  const loadLocalApps = (options?: { force?: boolean }) => {
    if (!listeners.size || !onListLocalApps || (externalAppsReady && !options?.force)) return
    externalAppsReady = false
    apps ??= createApps()
    if (!stopApps) stopApps = apps.subscribe(readApps)
    else if (options?.force || apps.getSnapshot().status === 'idle') void apps.reload()
  }
  const loadLocalMentions = (options?: { force?: boolean }) => {
    loadLocalSkills(options)
    loadLocalApps(options)
  }
  const receiveApps = () => {
    const next = appsStore.get()
    if (next === snapshot.apps) return
    externalAppsReady = true
    if (stopApps) apps!.update(() => next)
    publish({ apps: next, appsLoading: false, appsLoadError: false })
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        stopStore = appsStore.subscribe(receiveApps)
        receiveApps()
        if (initiallyLoad) loadLocalMentions()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        stopStore?.()
        stopStore = undefined
        stopApps?.()
        stopApps = undefined
        apps = undefined
        stopSkills?.()
        stopSkills = undefined
        publish({ loading: false, appsLoading: false })
      }
    },
    loadLocalApps,
    loadLocalMentions,
    publishApps() {
      if (!appsStore.suppressSync() && snapshot.apps.length) appsStore.publish(snapshot.apps)
    },
    invalidate(menuOpen: boolean) {
      if (!listeners.size) return
      skills.update(() => [])
      skillsInvalidated = true
      publish({ skills: [], loading: false, loadError: false })
      loadLocalApps({ force: true })
      if (menuOpen) loadLocalSkills({ force: true })
    },
  }
}
