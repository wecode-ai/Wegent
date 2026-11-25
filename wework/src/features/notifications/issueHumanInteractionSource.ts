import { dequal } from 'dequal'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeInteraction } from './runtimeInteractions'
import { issueHumanInteraction } from './issueHumanInteractions'

type Api = WorkbenchServices['issueHumanRequestsApi']
type Store = 'local' | 'backend'
interface Snapshot {
  items: RuntimeInteraction[]
  resolved: RuntimeInteraction[]
  error?: string
}
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** Inbox discovery never grants cached questions permission to reply. */
export function createIssueHumanInteractionSource(
  api: Api,
  store: Store,
  cached: RuntimeInteraction[]
) {
  let snapshot: Snapshot = {
    items: cached
      .filter(item => item.sharedRequest && item.project?.store === store)
      .map(item => ({ ...item, cached: true })),
    resolved: [],
  }
  let epoch = 0
  let sequence = 0
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<Snapshot>) => {
    const next = { ...snapshot, ...patch }
    if (
      next.error === snapshot.error &&
      dequal(next.items, snapshot.items) &&
      next.resolved === snapshot.resolved
    )
      return
    snapshot = next
    listeners.forEach(listener => listener())
  }
  const refresh = async () => {
    const requestedEpoch = epoch
    await Promise.resolve()
    if (!api || !listeners.size || requestedEpoch !== epoch) return
    const requestedSequence = ++sequence
    const current = () =>
      listeners.size > 0 && epoch === requestedEpoch && sequence === requestedSequence
    try {
      const response = await api.inbox()
      if (!current()) return
      const ids = new Set(response.items.map(item => item.id))
      const removed = snapshot.items.filter(
        item => item.sharedRequest && !ids.has(item.sharedRequest.id)
      )
      const incoming = response.items.map(request => issueHumanInteraction(request, store))
      if (removed.length)
        publish({ items: [...incoming, ...removed.map(item => ({ ...item, cached: true }))] })
      const retained: RuntimeInteraction[] = []
      const failures: string[] = []
      for (const previous of removed) {
        const project = previous.project!
        try {
          const result = await api.list(project.projectId, project.issueId)
          if (!current()) return
          const question = result.items.find(item => item.id === previous.sharedRequest!.id)
          if (question && ['resolved', 'cancelled'].includes(question.status)) {
            if (!snapshot.resolved.some(item => item.id === previous.id))
              publish({ resolved: [...snapshot.resolved, previous].slice(-100) })
          } else if (
            !question ||
            (question.recipient_user_id === previous.sharedRequest!.recipient_user_id &&
              question.responsible_user_id === previous.sharedRequest!.responsible_user_id)
          ) {
            // Missing metadata cannot settle a question; a confirmed handoff retires this inbox lease.
            retained.push({ ...previous, cached: true })
          }
        } catch (cause) {
          if (!current()) return
          retained.push({ ...previous, cached: true })
          failures.push(message(cause))
        }
      }
      if (!current()) return
      publish({
        items: [...incoming, ...retained],
        error: failures.length ? failures.join('\n') : undefined,
      })
    } catch (cause) {
      if (!current()) return
      publish({
        items: snapshot.items.map(item => ({ ...item, cached: true })),
        error: message(cause),
      })
    }
  }
  return {
    api,
    getSnapshot: () => snapshot,
    refresh,
    discover(localPending?: boolean) {
      return store === 'backend' || localPending === true || snapshot.items.length > 0
        ? refresh()
        : Promise.resolve()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        epoch += 1
        if (store === 'backend' || snapshot.items.length > 0) void refresh()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) epoch += 1
      }
    },
  }
}
