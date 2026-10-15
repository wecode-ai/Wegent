import { createContext, useContext } from 'react'
import type { RuntimeTaskReminderState } from '@/features/workbench/runtimeTaskReminders'

export type TaskSource = Pick<
  RuntimeTaskReminderState,
  'items' | 'unreadTaskKeys' | 'markRuntimeTaskRead'
>

/**
 * The assignment binding every task started from an Issue dispatch shares,
 * whether the user opened a notification or replied in the Issue timeline.
 */
export interface IssueTaskDispatchInput {
  humanAssignmentId: string
  dispatchId: string
  roundId: string
  assignmentId: string
  taskTitle: string
  instructions: string
  workflowStageId?: string
}

export interface IssueDispatchPersonalTaskAction extends IssueTaskDispatchInput {
  projectId: string
  itemId: string
  issueId: string
  dispatchTaskId: string
  idempotencyKey: string
}

export function issueDispatchPersonalTaskInput(
  action: Pick<IssueTaskDispatchInput, 'taskTitle' | 'instructions'>
): string {
  return `${action.taskTitle}\n\n${action.instructions}`
}

export type IssueDispatchNotificationAction = (
  action: IssueDispatchPersonalTaskAction
) => Promise<void>

export interface NotificationTaskContextValue {
  taskSource: TaskSource | null
  registerTaskSource: (id: string, source: TaskSource | null, active: boolean) => void
  issueDispatchAction: IssueDispatchNotificationAction | null
  registerIssueDispatchAction: (
    id: string,
    action: IssueDispatchNotificationAction | null,
    active: boolean
  ) => void
}

export const NotificationTaskContext = createContext<NotificationTaskContextValue | null>(null)

export function useNotificationTaskSource(): TaskSource | null {
  return useContext(NotificationTaskContext)?.taskSource ?? null
}

export function useIssueDispatchNotificationAction(): IssueDispatchNotificationAction | null {
  return useContext(NotificationTaskContext)?.issueDispatchAction ?? null
}
