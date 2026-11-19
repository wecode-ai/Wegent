import type { SetStateAction } from 'react'
import type { RuntimeInteractionsValue } from './RuntimeInteractionsContext'

interface PageState {
  history: boolean
  selected: string | null
  showList: boolean
  twoPanes: boolean
  routeId: string | null | undefined
  viewed: string | null
  dismissing: boolean
  dismissFailed: boolean
  originalNavigation: { id: string; url: string } | null
  focusListRequested: boolean
  focusListVersion: number
}
interface PageView {
  owner: string
  active: boolean
  selectedId?: string | null
  twoPanes: boolean
  interactions: RuntimeInteractionsValue | null
  projectCount: number | null
  refreshProjects(): Promise<void>
}
interface PageObservation {
  getSnapshot(): PageState
  subscribe(listener: () => void): () => void
}

const handoffRevision = (value: RuntimeInteractionsValue | null) =>
  value?.pending
    .filter(item => item.sharedRequest)
    .map(item => `${item.id}:${item.sharedRequest?.version}`)
    .sort()
    .join('|') ?? ''

function projectState(state: PageState, view: PageView): PageState {
  let next = state
  if (next.twoPanes !== view.twoPanes)
    next = {
      ...next,
      twoPanes: view.twoPanes,
      ...(!view.twoPanes ? { showList: false, focusListRequested: false } : {}),
    }
  if (next.routeId !== view.selectedId)
    next = {
      ...next,
      routeId: view.selectedId,
      selected: view.selectedId ?? null,
      history: false,
      showList: !view.selectedId,
      focusListRequested: false,
    }
  const viewed =
    view.active && !next.history && (view.twoPanes || !next.showList)
      ? ((next.selected
          ? view.interactions?.pending.find(item => item.id === next.selected)?.id
          : view.interactions?.pending[0]?.id) ?? null)
      : null
  return next.viewed === viewed ? next : { ...next, viewed }
}

/** A page owns one selected request lease and the project count it actually displays. */
export function createRuntimeInteractionsPageState(
  selectedId: string | null | undefined,
  twoPanes: boolean,
  initialInteractions: RuntimeInteractionsValue | null
) {
  let state: PageState = {
    history: false,
    selected: selectedId ?? null,
    showList: !selectedId,
    twoPanes,
    routeId: selectedId,
    viewed: null,
    dismissing: false,
    dismissFailed: false,
    originalNavigation: null,
    focusListRequested: false,
    focusListVersion: 0,
  }
  let current: PageView | undefined
  let observation: { view: PageView; binding: PageObservation } | undefined
  let generation = 0
  let attached = false
  let previousHandoff = handoffRevision(initialInteractions)
  let registered: { view: PageView; id: string | null } | undefined
  let reported:
    | {
        callback: NonNullable<RuntimeInteractionsValue['reportProjectPendingCount']>
        count: number | null
      }
    | undefined
  const listeners = new Set<() => void>()
  const synchronize = () => {
    if (!current || !listeners.size) return
    const callback = current.interactions?.registerView
    if (
      registered &&
      (registered.view.interactions?.registerView !== callback ||
        registered.view.owner !== current.owner)
    ) {
      registered.view.interactions?.registerView(registered.view.owner, null)
      registered = undefined
    }
    if (callback && (!registered || registered.id !== state.viewed)) {
      callback(current.owner, state.viewed)
      registered = { view: current, id: state.viewed }
    }
    const report = current.interactions?.reportProjectPendingCount
    if (reported && reported.callback !== report) {
      reported.callback(null)
      reported = undefined
    }
    if (report && (!reported || reported.count !== current.projectCount)) {
      report(current.projectCount)
      reported = { callback: report, count: current.projectCount }
    }
  }
  const change = (patch: Partial<PageState>) => {
    state = { ...state, ...patch }
    if (current) state = projectState(state, current)
    synchronize()
    listeners.forEach(listener => listener())
  }
  const set = <K extends keyof PageState>(key: K, value: SetStateAction<PageState[K]>) => {
    const next =
      typeof value === 'function'
        ? (value as (previous: PageState[K]) => PageState[K])(state[key])
        : value
    change({ ...state, [key]: next })
  }
  return {
    observe(view: PageView): PageObservation {
      const keys: (keyof PageView)[] = [
        'owner',
        'active',
        'selectedId',
        'twoPanes',
        'interactions',
        'projectCount',
        'refreshProjects',
      ]
      if (observation && keys.every(key => observation!.view[key] === view[key]))
        return observation.binding
      let base = state
      let projected = projectState(base, view)
      const getSnapshot = () => {
        if (base !== state) {
          base = state
          projected = projectState(base, view)
        }
        return projected
      }
      const binding: PageObservation = {
        getSnapshot,
        subscribe(listener: () => void) {
          const previous = current
          state = getSnapshot()
          base = state
          projected = state
          current = view
          listeners.add(listener)
          synchronize()
          if (
            view.active &&
            (!attached ||
              !previous?.active ||
              previous.interactions?.refresh !== view.interactions?.refresh)
          )
            void view.interactions?.refresh()
          attached = true
          const revision = handoffRevision(view.interactions)
          if (view.active && revision !== previousHandoff) {
            previousHandoff = revision
            void view.refreshProjects()
          }
          return () => {
            listeners.delete(listener)
            queueMicrotask(() => {
              if (listeners.size) return
              attached = false
              generation++
              registered?.view.interactions?.registerView(registered.view.owner, null)
              registered = undefined
              reported?.callback(null)
              reported = undefined
            })
          }
        },
      }
      observation = { view, binding }
      return binding
    },
    capture() {
      const epoch = generation
      const identity = current?.interactions?.registerView
      return () =>
        listeners.size > 0 &&
        generation === epoch &&
        current?.interactions?.registerView === identity
    },
    beginDismiss() {
      if (state.dismissing) return false
      change({ dismissing: true, dismissFailed: false })
      return true
    },
    finishDismiss: () => change({ dismissing: false }),
    failDismiss: () => change({ dismissFailed: true }),
    setHistory: (value: SetStateAction<boolean>) => set('history', value),
    setSelected: (value: SetStateAction<string | null>) => set('selected', value),
    setShowList(value: boolean) {
      change({ showList: value, focusListRequested: false })
    },
    returnToList() {
      change({
        showList: true,
        focusListRequested: true,
        focusListVersion: state.focusListVersion + 1,
      })
    },
    setOriginalNavigation(id: string, url: string) {
      if (state.originalNavigation?.id !== id || state.originalNavigation.url !== url)
        change({ originalNavigation: { id, url } })
    },
  }
}
