import { createContext, useContext } from 'react'
import type { RuntimeTaskReminderState } from '@/features/workbench/runtimeTaskReminders'

export type TaskSource = Pick<
  RuntimeTaskReminderState,
  'items' | 'unreadTaskKeys' | 'markRuntimeTaskRead'
>

export interface NotificationTaskContextValue {
  taskSource: TaskSource | null
  registerTaskSource: (id: string, source: TaskSource | null, active: boolean) => void
}

export const NotificationTaskContext = createContext<NotificationTaskContextValue | null>(null)

export function useNotificationTaskSource(): TaskSource | null {
  return useContext(NotificationTaskContext)?.taskSource ?? null
}
