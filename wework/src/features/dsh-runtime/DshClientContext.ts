import { createContext, useContext } from 'react'

import type { Context } from '@deepseek-ai/cordis'

export const DshClientContext = createContext<Context | null>(null)

export function useDshClientContext(): Context | null {
  return useContext(DshClientContext)
}
