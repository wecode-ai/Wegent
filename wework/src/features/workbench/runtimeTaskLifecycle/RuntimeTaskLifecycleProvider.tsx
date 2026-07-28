import type { ReactNode } from 'react'
import { RuntimeTaskLifecycleContext } from './internalContext'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

export function RuntimeTaskLifecycleProvider({
  store,
  children,
}: {
  store: RuntimeTaskLifecycleStore
  children: ReactNode
}) {
  return (
    <RuntimeTaskLifecycleContext.Provider value={store}>
      {children}
    </RuntimeTaskLifecycleContext.Provider>
  )
}
