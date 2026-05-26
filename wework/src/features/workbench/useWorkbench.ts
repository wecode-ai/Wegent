import { createContext, useContext } from 'react'
import type { WorkbenchContextValue } from './WorkbenchProvider'

export const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)

export function useWorkbench(): WorkbenchContextValue {
  const value = useContext(WorkbenchContext)
  if (!value) {
    throw new Error('useWorkbench must be used within WorkbenchProvider')
  }
  return value
}
