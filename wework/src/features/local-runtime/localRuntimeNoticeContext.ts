import { createContext } from 'react'

export const LocalRuntimeNoticeContext = createContext<{
  error: string
  retrying: boolean
  retry: () => void
} | null>(null)
