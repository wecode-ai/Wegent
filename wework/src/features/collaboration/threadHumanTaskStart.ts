import type { ProjectChatClient } from '@wegent/chat-core'
import type { ChatGroupApi } from '@/api/chatGroups'
import type { IssueTaskDispatchInput } from '@/features/notifications/NotificationTaskSourceContext'
import { humanTaskDispatchInput } from '@/features/todo/humanTaskDispatch'
import { requireThreadPersonalTaskStart } from './threadPersonalTaskAccess'
import { createThreadExecutionActions } from './threadExecutionActions'
import type { ThreadActionContext } from './threadActions'

/** Private assistance does not claim shared work; explicit dispatches require their exact current assignment. */
export async function requireThreadHumanTaskStart({
  context,
  dispatch,
  groups,
  chat,
  unavailable,
  isCurrent,
}: {
  context: ThreadActionContext
  dispatch?: IssueTaskDispatchInput
  groups?: ChatGroupApi
  chat?: ProjectChatClient
  unavailable: string
  isCurrent(): boolean
}) {
  if (!isCurrent()) throw new Error(unavailable)
  if (!dispatch) {
    const item = await requireThreadPersonalTaskStart(context, unavailable)
    if (!isCurrent()) throw new Error(unavailable)
    return item
  }
  if (!groups || !chat) throw new Error(unavailable)
  const current = await createThreadExecutionActions({
    context,
    groups,
    chat,
    unavailable,
    isCurrent,
    onChanged() {},
  }).resolveHumanTask()
  const expected = humanTaskDispatchInput(current.dispatch)
  const fields: Array<keyof IssueTaskDispatchInput> = [
    'humanAssignmentId',
    'dispatchId',
    'roundId',
    'assignmentId',
    'taskTitle',
    'instructions',
    'workflowStageId',
  ]
  if (!isCurrent() || fields.some(field => expected[field] !== dispatch[field]))
    throw new Error(unavailable)
  return current.item
}
