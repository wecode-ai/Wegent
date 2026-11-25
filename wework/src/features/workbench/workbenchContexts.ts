import { createContext } from 'react'
import type { RuntimeTaskReminderState } from './runtimeTaskReminders'
import type { WorkbenchContextValue, WorkbenchPaneContextValue } from './workbenchContextTypes'

export const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)
export const WorkbenchPaneContext = createContext<WorkbenchPaneContextValue | null>(null)
export const WorkbenchQueueActionsContext = createContext<Pick<
  WorkbenchContextValue,
  'forceStartRuntimeTask' | 'reorderQueuedRuntimeTask' | 'setWorkbenchError'
> | null>(null)

export const WorkbenchReminderItemsContext = createContext<RuntimeTaskReminderState['items']>([])
export const WorkbenchSidebarRemindersContext = createContext<Pick<
  RuntimeTaskReminderState,
  'unreadTaskKeys' | 'unreadMessageCounts' | 'markRuntimeTaskRead'
> | null>(null)

export const WorkbenchOwnerLeaseContext = createContext<(() => () => void) | null>(null)
