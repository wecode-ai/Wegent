import type { ReactNode } from 'react'

import type { Context } from '@deepseek-ai/cordis'

import { DshClientContext } from './DshClientContext'

export function DshClientContextProvider({
  children,
  context,
}: {
  children: ReactNode
  context: Context | null
}) {
  return <DshClientContext.Provider value={context}>{children}</DshClientContext.Provider>
}
