import type { CollaborationLocale } from '../i18n'
import { localizeBuiltinTemplateRecord } from './builtins'
import { templateMessages } from './messages'
import type { TemplateRecord } from './types'
import type { CollaborationTemplateStore } from './store'

export interface TemplatePageCard {
  key: string
  name: string
  description: string
  version: string
  record?: TemplateRecord
  id: number | null
  ownerId: number
  namespace: string
  installed?: boolean
}
interface TemplatePageSnapshot {
  view: 'catalog' | 'bindings' | null
  selected: TemplateRecord | null
  deleting: TemplatePageCard | null
  importOpen: boolean
  busy: boolean
  importBusy: boolean
  focusRequest: number
  sectionFocusRequest: number
}
const hasPanel = (state: TemplatePageSnapshot) =>
  !!(state.importOpen || state.deleting || state.selected)

/** The picker, its host title and Back actions share the actual template navigation state. */
export function createTemplatePageNavigation(
  owner: CollaborationTemplateStore | null,
  workspaceScope?: string
) {
  let snapshot: TemplatePageSnapshot = {
    view: null,
    selected: null,
    deleting: null,
    importOpen: false,
    busy: false,
    importBusy: false,
    focusRequest: 0,
    sectionFocusRequest: 0,
  }
  const listeners = new Set<() => void>()
  const pages = new Map<object, Set<() => void>>()
  let currentPage: object | undefined
  const publish = (patch: Partial<TemplatePageSnapshot>) => {
    const next = { ...snapshot, ...patch }
    if (
      (hasPanel(snapshot) || snapshot.busy || snapshot.importBusy) &&
      !hasPanel(next) &&
      !next.busy &&
      !next.importBusy
    )
      next.focusRequest++
    snapshot = next
    for (const listener of listeners) listener()
    for (const pageListeners of pages.values()) for (const listener of pageListeners) listener()
  }
  const resetPanel = {
    selected: null,
    deleting: null,
    importOpen: false,
    busy: false,
    importBusy: false,
  }
  const leave = () =>
    publish({ ...resetPanel, view: null, sectionFocusRequest: snapshot.sectionFocusRequest + 1 })
  const closeDetail = () => {
    if (snapshot.importOpen) {
      if (!snapshot.importBusy) publish({ importOpen: false })
    } else if (snapshot.deleting) {
      if (!snapshot.busy) publish({ deleting: null })
    } else if (snapshot.selected && !snapshot.busy) publish({ selected: null })
  }
  return {
    owner,
    workspaceScope,
    getRecord: (id: number) => owner!.library.remote!.get(id),
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    subscribePage(owner: object, listener: () => void) {
      currentPage = owner
      let pageListeners = pages.get(owner)
      if (!pageListeners) {
        pageListeners = new Set()
        pages.set(owner, pageListeners)
      }
      pageListeners.add(listener)
      return () => {
        pageListeners!.delete(listener)
        if (!pageListeners!.size) pages.delete(owner)
      }
    },
    hasPage: (owner: object) => currentPage === owner && !!pages.get(owner)?.size,
    setSelected: (selected: TemplateRecord | null) => publish({ selected }),
    setDeleting: (deleting: TemplatePageCard | null) => publish({ deleting }),
    setImportOpen: (importOpen: boolean) => publish({ importOpen }),
    setBusy: (busy: boolean) => publish({ busy }),
    setImportBusy: (importBusy: boolean) => publish({ importBusy }),
    showCatalog: () => publish({ ...resetPanel, view: 'catalog' }),
    showBindings: () => publish({ ...resetPanel, view: 'bindings' }),
    leave,
    closeDetail,
    back: () => {
      if (snapshot.view === 'catalog' && hasPanel(snapshot)) closeDetail()
      else leave()
    },
  }
}
export type TemplatePageNavigation = ReturnType<typeof createTemplatePageNavigation>

export function templatePageDetail(
  navigation: TemplatePageNavigation,
  locale: CollaborationLocale,
  state = navigation.getSnapshot()
) {
  const m = templateMessages[locale]
  const title = state.importOpen
    ? m.importTitle
    : state.deleting
      ? m.delete
      : state.selected
        ? localizeBuiltinTemplateRecord(state.selected, locale).document.spec.displayName
        : null
  return title === null ? null : { title, onBack: navigation.closeDetail }
}
export function templateConfigurationDetail(
  navigation: TemplatePageNavigation,
  locale: CollaborationLocale,
  state = navigation.getSnapshot()
) {
  const { view } = state
  return view
    ? {
        title:
          view === 'bindings'
            ? templateMessages[locale].bindingsTitle
            : (templatePageDetail(navigation, locale, state)?.title ??
              templateMessages[locale].title),
        onBack: navigation.back,
      }
    : null
}
