import type { ReactNode } from 'react'
import { RuntimeTaskLifecycleContext, RuntimeTaskLifecycleWriterContext } from './internalContext'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

export function RuntimeTaskLifecycleProvider({
  store,
  writerStore = store,
  children,
}: {
  store: RuntimeTaskLifecycleStore
  writerStore?: RuntimeTaskLifecycleStore
  children: ReactNode
}) {
  return (
    <RuntimeTaskLifecycleContext.Provider value={store}>
      <RuntimeTaskLifecycleWriterContext.Provider value={writerStore}>
        {children}
      </RuntimeTaskLifecycleWriterContext.Provider>
    </RuntimeTaskLifecycleContext.Provider>
  )
}
