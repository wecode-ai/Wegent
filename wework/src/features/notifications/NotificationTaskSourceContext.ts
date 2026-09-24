import { createContext, useContext } from 'react'
import type { RuntimeTaskReminderState } from '@/features/workbench/runtimeTaskReminders'

export type TaskSource = Pick<
  RuntimeTaskReminderState,
  'items' | 'unreadTaskKeys' | 'markRuntimeTaskRead'
>

export interface IssueDispatchPersonalTaskAction {
  projectId: string
  itemId: string
  issueId: string
  dispatchTaskId: string
  idempotencyKey: string
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
