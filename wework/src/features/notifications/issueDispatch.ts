import type { IssueDispatchPersonalTaskAction } from './NotificationTaskSourceContext'

interface IssueDispatchSubscriber {
  /** Whether this board shows the Issue the request belongs to right now. */
  shows: (action: IssueDispatchPersonalTaskAction) => boolean
  answer: (action: IssueDispatchPersonalTaskAction) => void
}

/**
 * Assignment notifications are answered by the board of the project they name,
 * which need not be the surface on screen when the reader clicks. The intent
 * waits here until a board that shows that Issue takes it, so a click works
 * from any tab, not only from the project it points at.
 */
const REQUEST_TTL_MS = 2 * 60_000

interface PendingIssueDispatch {
  action: IssueDispatchPersonalTaskAction
  expiresAt: number
}

const pending = new Map<string, PendingIssueDispatch>()
const subscribers = new Set<IssueDispatchSubscriber>()

export function requestIssueDispatch(action: IssueDispatchPersonalTaskAction): void {
  pending.set(action.idempotencyKey, { action, expiresAt: Date.now() + REQUEST_TTL_MS })
  deliver()
}

/** Answer every waiting request this board shows, and keep answering new ones. */
export function subscribeIssueDispatch(subscriber: IssueDispatchSubscriber): () => void {
  subscribers.add(subscriber)
  deliver()
  return () => {
    subscribers.delete(subscriber)
  }
}

/** Hand each waiting request to the one board that can open its personal task. */
function deliver(): void {
  const now = Date.now()
  for (const [key, request] of pending) {
    // A click that no board reached in time is stale; it must not open a task
    // out of the blue when that project is visited later.
    if (request.expiresAt <= now) {
      pending.delete(key)
      continue
    }
    const { action } = request
    const subscriber = [...subscribers].find(candidate => candidate.shows(action))
    if (!subscriber) continue
    pending.delete(key)
    subscriber.answer(action)
  }
}
