import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { StandInRole } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import { raceWithTimeout } from '@/lib/promise-timeout'
import { getStandInErrorMessage, reportStandInError } from '@/lib/stand-in-error-message'
import { dequal } from 'dequal'
import { effectiveProjectSource } from './standInProjects'

type ConnectionConfiguration = Pick<StandInRole, 'connections' | 'collaboration' | 'calendar'>

export function hasConnectionDraft(
  draft: ConnectionConfiguration,
  saved: ConnectionConfiguration | undefined,
  view?: string | null
): boolean {
  if (!saved) return false
  if (view === 'projects')
    return !dequal(
      effectiveProjectSource(draft.collaboration),
      effectiveProjectSource(saved.collaboration)
    )
  if (view === 'time') return !dequal(draft.calendar, saved.calendar)
  if (view) {
    const scope = (configuration: ConnectionConfiguration) =>
      (configuration.connections ?? []).filter(row => row.providerId === view)
    return !dequal(scope(draft), scope(saved))
  }
  return (
    hasConnectionDraft(draft, saved, 'projects') ||
    hasConnectionDraft(draft, saved, 'time') ||
    !dequal(draft.connections ?? [], saved.connections ?? [])
  )
}

export interface ConnectionSettingsInput {
  api?: StandInExecutorApi
  deviceId: string
  locale: string
  timeTitle: string
  projectsTitle: string
  unavailableTitle: string
  onScheduleDirtyChange?(dirty: boolean): void
  onCalendarViewChange?(open: boolean): void
  onDetailViewChange?(open: boolean): void
  onDetailTitleChange?(title: string | null, view: string | null, scopeTitle: string | null): void
}

/** Own the selected connection editor and its scoped provider catalog. */
export function createConnectionSettingsModel(
  initial: ConnectionSettingsInput,
  initialCalendar: boolean
) {
  let input = initial
  let view: string | null = initialCalendar ? 'time' : null
  let scopeTitle: string | null = null
  let scheduleDirty = false
  let emailDirty = false
  let installing = false
  let mutationError: string | null = null
  const listeners = new Set<() => void>()
  function createCatalog(owner: ConnectionSettingsInput) {
    return createAsyncResource(
      JSON.stringify(['connection-providers', owner.deviceId, owner.locale]),
      async () => {
        if (!owner.api) return []
        try {
          const result = await raceWithTimeout(
            owner.api.connectionProviders(owner.deviceId),
            15_000,
            () => Object.assign(new Error('App catalog timed out'), { code: 'app_catalog_timeout' })
          )
          return result.items.map(item => ({ ...item, ...item.locales?.[owner.locale] }))
        } catch (cause) {
          reportStandInError('load_connection_catalog', cause, owner.deviceId)
          throw cause
        }
      },
      { refreshOnSubscribe: true }
    )
  }
  let catalog = createCatalog(input)
  let stopCatalog: (() => void) | undefined
  function readSnapshot() {
    const query = catalog.getSnapshot()
    const providers = query.data ?? []
    const provider = providers.find(item => item.id === view)
    const title =
      view === 'time'
        ? input.timeTitle
        : view === 'projects'
          ? input.projectsTitle
          : (provider?.displayName ?? (view ? input.unavailableTitle : null))
    return {
      view,
      scheduleDirty,
      emailDirty,
      providers,
      title,
      api: input.api,
      deviceId: input.deviceId,
      locale: input.locale,
      loading:
        view !== 'time' &&
        (installing ||
          Boolean(input.api && (query.status === 'idle' || query.status === 'loading'))),
      error:
        view === 'time'
          ? null
          : (mutationError ??
            (query.status === 'error' ? getStandInErrorMessage(query.error) : null)),
    }
  }
  let snapshot = readSnapshot()
  let notification:
    | {
        detail: boolean
        calendar: boolean
        dirty: boolean
        title: string | null
        scopeTitle: string | null
      }
    | undefined
  function notifyOwner(force = false) {
    if (!listeners.size) return
    const next = {
      detail: view !== null,
      calendar: view === 'time',
      dirty: scheduleDirty || emailDirty,
      title: snapshot.title,
      scopeTitle,
    }
    if (force || next.detail !== notification?.detail) input.onDetailViewChange?.(next.detail)
    if (force || next.calendar !== notification?.calendar)
      input.onCalendarViewChange?.(next.calendar)
    if (force || next.dirty !== notification?.dirty) input.onScheduleDirtyChange?.(next.dirty)
    if (force || next.title !== notification?.title || next.scopeTitle !== notification?.scopeTitle)
      input.onDetailTitleChange?.(next.title, view, next.scopeTitle)
    notification = next
  }
  function publish() {
    snapshot = readSnapshot()
    listeners.forEach(listener => listener())
    notifyOwner()
  }
  function observeCatalog() {
    if (view === 'time' || !input.api || !listeners.size) {
      stopCatalog?.()
      stopCatalog = undefined
    } else if (!stopCatalog) stopCatalog = catalog.subscribe(publish)
  }
  const reload = () => {
    mutationError = null
    if (view !== 'time' && input.api) void catalog.reload()
    else publish()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, next: ConnectionSettingsInput) {
      const changed =
        input.api !== next.api || input.deviceId !== next.deviceId || input.locale !== next.locale
      if (changed) {
        stopCatalog?.()
        stopCatalog = undefined
        catalog = createCatalog(next)
        mutationError = null
        installing = false
      }
      input = next
      listeners.add(listener)
      snapshot = readSnapshot()
      observeCatalog()
      notifyOwner(true)
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          next.onDetailViewChange?.(false)
          next.onCalendarViewChange?.(false)
          next.onDetailTitleChange?.(null, null, null)
          stopCatalog?.()
          stopCatalog = undefined
        })
      }
    },
    setView(next: string | null) {
      if (next === view) return
      view = next
      scopeTitle = null
      observeCatalog()
      publish()
    },
    setScopeTitle(next: string | null) {
      if (next === scopeTitle) return
      scopeTitle = next
      notifyOwner()
    },
    setScheduleDirty(dirty: boolean) {
      if (scheduleDirty === dirty) return
      scheduleDirty = dirty
      publish()
    },
    setEmailDirty(dirty: boolean) {
      if (emailDirty === dirty) return
      emailDirty = dirty
      publish()
    },
    reload,
    async install(item: ConnectionProviderDescriptor) {
      const owner = input
      const source = catalog
      if (!owner.api || installing) return
      installing = true
      mutationError = null
      publish()
      try {
        await owner.api.installConnectionDependencies(
          owner.deviceId,
          item.id,
          item.dependencies
            .filter(dependency => dependency.status === 'missing')
            .map(dependency => dependency.alias)
        )
        if (catalog === source && listeners.size) void catalog.reload()
      } catch (cause) {
        if (catalog === source && listeners.size) mutationError = getStandInErrorMessage(cause)
      } finally {
        if (catalog === source) {
          installing = false
          publish()
        }
      }
    },
  }
}
