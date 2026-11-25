import { useContext } from 'react'
import type { WorkbenchContextValue, WorkbenchPaneContextValue } from './workbenchContextTypes'
import { WorkbenchContext, WorkbenchPaneContext } from './workbenchContexts'

export { WorkbenchContext, WorkbenchPaneContext } from './workbenchContexts'

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
