import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'

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
  onDetailTitleChange?(title: string | null): void
}

/** Own the selected connection editor and its scoped provider catalog. */
export function createConnectionSettingsModel(
  initial: ConnectionSettingsInput,
  initialCalendar: boolean
) {
  let input = initial
  let view: string | null = initialCalendar ? 'time' : null
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
        const result = await owner.api.connectionProviders(owner.deviceId)
        return result.items.map(item => ({ ...item, ...item.locales?.[owner.locale] }))
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
    | { detail: boolean; calendar: boolean; dirty: boolean; title: string | null }
    | undefined
  function notifyOwner(force = false) {
    if (!listeners.size) return
    const next = {
      detail: view !== null,
      calendar: view === 'time',
      dirty: scheduleDirty || emailDirty,
      title: snapshot.title,
    }
    if (force || next.detail !== notification?.detail) input.onDetailViewChange?.(next.detail)
    if (force || next.calendar !== notification?.calendar)
      input.onCalendarViewChange?.(next.calendar)
    if (force || next.dirty !== notification?.dirty) input.onScheduleDirtyChange?.(next.dirty)
    if (force || next.title !== notification?.title) input.onDetailTitleChange?.(next.title)
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
          next.onDetailTitleChange?.(null)
          stopCatalog?.()
          stopCatalog = undefined
        })
      }
    },
    setView(next: string | null) {
      if (next === view) return
      view = next
      observeCatalog()
      publish()
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
