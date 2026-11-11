import { createContext } from 'react'

export const LocalRuntimeNoticeContext = createContext<{
  error: string
  retry: () => void
} | null>(null)
