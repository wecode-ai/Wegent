import type { RuntimeTaskAddress } from '@/types/api'
import type {
  QuestionDiscussionRequest,
  QuestionDiscussionTab,
  QuestionDiscussionStore,
} from './questionDiscussion'

export interface QuestionDiscussionPanel {
  tab: QuestionDiscussionTab
  request: QuestionDiscussionRequest
}
export interface QuestionDiscussionPanelSnapshot {
  accountKey: string | null
  panels: readonly QuestionDiscussionPanel[]
  activation: QuestionDiscussionPanel | null
}
interface PanelView {
  accountKey: string | null
  authority: QuestionDiscussionStore['requestPanel'] | undefined
  address: RuntimeTaskAddress | null | undefined
  active: boolean
  request: QuestionDiscussionRequest | null | undefined
  consume?: (request: QuestionDiscussionRequest) => void
}
interface PanelObservation {
  getSnapshot(): QuestionDiscussionPanelSnapshot
  subscribe(notify: () => void): () => void
  close(tab: QuestionDiscussionTab): void
}
const claimed = new WeakMap<
  QuestionDiscussionRequest,
  { owner: string; accountKey: string | null; authority: PanelView['authority'] }
>()
const empty = (accountKey: string | null): QuestionDiscussionPanelSnapshot => ({
  accountKey,
  panels: [],
  activation: null,
})

/** A pane owns actual discussion panels after an exact-source request is claimed. */
export function createQuestionDiscussionPanels(owner: string) {
  let snapshot = empty(null)
  let authority: PanelView['authority']
  const listeners = new Set<() => void>()
  let observation: { view: PanelView; binding: PanelObservation } | undefined
  const publish = (next: QuestionDiscussionPanelSnapshot) => {
    snapshot = next
    listeners.forEach(notify => notify())
  }
  const close = (
    tab: QuestionDiscussionTab,
    accountKey: string | null,
    requestedAuthority: PanelView['authority']
  ) => {
    if (snapshot.accountKey !== accountKey || authority !== requestedAuthority) return
    const panel = snapshot.panels.find(panel => panel.tab === tab)
    const claim = panel && claimed.get(panel.request)
    if (
      !claim ||
      claim.owner !== owner ||
      claim.accountKey !== accountKey ||
      claim.authority !== requestedAuthority
    )
      return
    publish({
      ...snapshot,
      panels: snapshot.panels.filter(panel => panel.tab !== tab),
      activation: snapshot.activation?.tab === tab ? null : snapshot.activation,
    })
  }
  return {
    observe(view: PanelView): PanelObservation {
      const cached = observation
      const previous = cached?.view
      if (
        cached &&
        previous &&
        previous.accountKey === view.accountKey &&
        previous.authority === view.authority &&
        previous.active === view.active &&
        previous.address?.deviceId === view.address?.deviceId &&
        previous.address?.taskId === view.address?.taskId &&
        previous.request === view.request &&
        previous.consume === view.consume
      )
        return cached.binding
      const inactive = empty(view.accountKey)
      const binding: PanelObservation = {
        close: tab => close(tab, view.accountKey, view.authority),
        getSnapshot: () =>
          snapshot.accountKey === view.accountKey && authority === view.authority
            ? snapshot
            : inactive,
        subscribe(notify: () => void) {
          listeners.add(notify)
          if (snapshot.accountKey !== view.accountKey || authority !== view.authority) {
            authority = view.authority
            publish(inactive)
          }
          const request = view.request
          if (
            view.active &&
            request &&
            !claimed.has(request) &&
            request.source.deviceId === view.address?.deviceId &&
            request.source.taskId === view.address?.taskId
          ) {
            claimed.set(request, { owner, accountKey: view.accountKey, authority: view.authority })
            const panel: QuestionDiscussionPanel = { tab: `discussion:${request.key}`, request }
            const panels = snapshot.panels.some(item => item.tab === panel.tab)
              ? snapshot.panels.map(item => (item.tab === panel.tab ? panel : item))
              : [...snapshot.panels, panel]
            snapshot = { accountKey: view.accountKey, panels, activation: panel }
            view.consume?.(request)
            listeners.forEach(listener => listener())
          }
          return () => {
            listeners.delete(notify)
          }
        },
      }
      observation = { view, binding }
      return binding
    },
  }
}

export function reconcileQuestionDiscussionPanels<Tab extends string>(
  previous: QuestionDiscussionPanelSnapshot | null,
  current: QuestionDiscussionPanelSnapshot,
  tabs: readonly Tab[],
  selected: Tab | 'launcher'
) {
  const currentTabs = new Set(current.panels.map(panel => panel.tab))
  const removed = new Set<string>(
    previous?.panels.filter(panel => !currentTabs.has(panel.tab)).map(panel => panel.tab)
  )
  const retained = tabs.filter(tab => !removed.has(tab))
  const nextTabs: (Tab | QuestionDiscussionTab)[] = [...retained]
  const activation = previous?.activation !== current.activation ? current.activation : null
  if (activation && !nextTabs.includes(activation.tab)) nextTabs.push(activation.tab)
  const collapsed = removed.size > 0 && retained.length === 0
  const view =
    activation?.tab ??
    (collapsed
      ? 'launcher'
      : removed.has(selected)
        ? (nextTabs[nextTabs.length - 1] ?? 'launcher')
        : selected)
  return {
    tabs: nextTabs,
    view,
    opened: Boolean(activation),
    collapsed,
    emptied: removed.size > 0 && nextTabs.length === 0,
  }
}
