import { createContext } from 'react'
import type { ProjectBoardGroupBy } from './useProjectBoardState'

export const ProjectBoardCardContext = createContext<{
  columnKey: string
  groupBy: ProjectBoardGroupBy
} | null>(null)
