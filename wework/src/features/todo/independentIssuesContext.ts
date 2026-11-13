import { createContext, useContext } from 'react'
import type { PersonalIssuesApi } from '@/api/personalIssues'

export type IndependentIssuesContextValue = { api: PersonalIssuesApi | null; userId: number; revision: number; create(): void; open(id: string): void }
export const IndependentIssuesContext = createContext<IndependentIssuesContextValue | null>(null)
export const useIndependentIssues = () => useContext(IndependentIssuesContext)
