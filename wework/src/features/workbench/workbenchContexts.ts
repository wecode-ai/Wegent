import { createContext } from 'react'
import type { WorkbenchContextValue, WorkbenchPaneContextValue } from './workbenchContextTypes'

export const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)
export const WorkbenchPaneContext = createContext<WorkbenchPaneContextValue | null>(null)
