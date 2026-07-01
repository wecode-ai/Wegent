import { createContext, useContext } from 'react'
import type { WorkbenchContextValue, WorkbenchPaneContextValue } from './workbenchContextTypes'

export const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)
export const WorkbenchPaneContext = createContext<WorkbenchPaneContextValue | null>(null)

export function useWorkbench(): WorkbenchContextValue {
  const value = useContext(WorkbenchContext)
  if (!value) {
    throw new Error('useWorkbench must be used within WorkbenchProvider')
  }
  return value
}

export function useWorkbenchPaneContext(): WorkbenchPaneContextValue {
  const value = useContext(WorkbenchPaneContext)
  if (!value) {
    throw new Error('useWorkbenchPaneContext must be used within WorkbenchProvider')
  }
  return value
}
