/**
 * What an assignment notification asks for: the personal task the assigner
 * handed to this reader on one Issue, and the assignments it feeds back into.
 */
export interface IssueDispatchPersonalTaskAction {
  projectId: string
  itemId: string
  issueId: string
  dispatchTaskId: string
  idempotencyKey: string
  humanAssignmentId: string
  dispatchId: string
  roundId: string
  assignmentId: string
  taskTitle: string
  instructions: string
  workflowStageId?: string
}

/** The composer opening line of a personal task created from an assignment. */
export function issueDispatchPersonalTaskInput(
  action: Pick<IssueDispatchPersonalTaskAction, 'taskTitle' | 'instructions'>
): string {
  return `${action.taskTitle}\n\n${action.instructions}`
}

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
const pending = new Map<string, IssueDispatchPersonalTaskAction>()
const subscribers = new Set<IssueDispatchSubscriber>()

export function requestIssueDispatch(action: IssueDispatchPersonalTaskAction): void {
  pending.set(action.idempotencyKey, action)
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
  for (const [key, action] of pending) {
    const subscriber = [...subscribers].find(candidate => candidate.shows(action))
    if (!subscriber) continue
    pending.delete(key)
    subscriber.answer(action)
  }
}
