import { createContext, useContext } from 'react'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { PersonalIssuesApi } from '@/api/personalIssues'

export type IndependentIssuesContextValue = {
  api: PersonalIssuesApi | null
  collaborationApi?: SharedWorkspaceApi
  userId: number
  revision: number
  selectedId?: string
  create(): void
  open(id: string): void
}
export const IndependentIssuesContext = createContext<IndependentIssuesContextValue | null>(null)
export const useIndependentIssues = () => useContext(IndependentIssuesContext)
