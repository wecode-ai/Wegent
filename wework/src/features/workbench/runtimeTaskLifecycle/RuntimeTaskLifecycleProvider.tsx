import { useEffect, type ReactNode } from 'react'
import type { RuntimeTaskAddress } from '@/types/api'
import { RuntimeTaskLifecycleContext } from './internalContext'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

const E2E_RUNTIME_LIFECYCLE_EVENT = 'wework:e2e:runtime-task-lifecycle'

export function RuntimeTaskLifecycleProvider({
  store,
  children,
}: {
  store: RuntimeTaskLifecycleStore
  children: ReactNode
}) {
  useEffect(() => {
    if (import.meta.env.VITE_WEWORK_E2E !== 'true') return

    const handleLifecycleEvent = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          address: RuntimeTaskAddress
          type: string
          turnId?: string | null
        }>
      ).detail
      if (detail?.type === 'turn_settled') {
        store.turnSettled(detail.address, detail.turnId)
      }
    }
    window.addEventListener(E2E_RUNTIME_LIFECYCLE_EVENT, handleLifecycleEvent)
    return () => window.removeEventListener(E2E_RUNTIME_LIFECYCLE_EVENT, handleLifecycleEvent)
  }, [store])

  return (
    <RuntimeTaskLifecycleContext.Provider value={store}>
      {children}
    </RuntimeTaskLifecycleContext.Provider>
  )
}
