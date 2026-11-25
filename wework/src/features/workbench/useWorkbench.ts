import { useContext } from 'react'
import type { WorkbenchContextValue, WorkbenchPaneContextValue } from './workbenchContextTypes'
import {
  WorkbenchContext,
  WorkbenchPaneContext,
  WorkbenchReminderItemsContext,
  WorkbenchSidebarRemindersContext,
} from './workbenchContexts'
import { EMPTY_RUNTIME_TASK_REMINDERS } from './runtimeTaskReminders'

export { WorkbenchContext, WorkbenchPaneContext } from './workbenchContexts'

export function useWorkbench(): WorkbenchContextValue {
  const value = useContext(WorkbenchContext)
  if (!value) {
    throw new Error('useWorkbench must be used within WorkbenchProvider')
  }
  return value
}

export function useWorkbenchReminderItems() {
  return useContext(WorkbenchReminderItemsContext)
}

export function useWorkbenchSidebarReminders() {
  return useContext(WorkbenchSidebarRemindersContext) ?? EMPTY_RUNTIME_TASK_REMINDERS
}

export function useWorkbenchPaneContext(): WorkbenchPaneContextValue {
  const value = useContext(WorkbenchPaneContext)
  if (!value) {
    throw new Error('useWorkbenchPaneContext must be used within WorkbenchProvider')
  }
  return value
}
