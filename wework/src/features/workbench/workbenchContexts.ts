import { createContext } from 'react'
import type { WorkbenchContextValue, WorkbenchPaneContextValue } from './workbenchContextTypes'
import type { RuntimeTaskReminderState } from './runtimeTaskReminders'

export const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)
export const WorkbenchPaneContext = createContext<WorkbenchPaneContextValue | null>(null)
export const RuntimeTaskRemindersContext = createContext<RuntimeTaskReminderState | null>(null)
export const WorkbenchQueueActionsContext = createContext<Pick<
  WorkbenchContextValue,
  'forceStartRuntimeTask' | 'reorderQueuedRuntimeTask' | 'setWorkbenchError'
> | null>(null)

export const WorkbenchOwnerLeaseContext = createContext<(() => () => void) | null>(null)
