import { useEffect, type ReactNode } from 'react'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimePaneTranscript } from '@/types/workbench'
import { RuntimeTaskLifecycleContext, RuntimeTaskLifecycleWriterContext } from './internalContext'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

const E2E_RUNTIME_LIFECYCLE_EVENT = 'wework:e2e:runtime-task-lifecycle'

export function RuntimeTaskLifecycleProvider({
  store,
  writerStore = store,
  children,
}: {
  store: RuntimeTaskLifecycleStore
  writerStore?: RuntimeTaskLifecycleStore
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
          transcript?: RuntimePaneTranscript
        }>
      ).detail
      if (detail?.type === 'turn_settled') {
        writerStore.turnSettled(detail.address, detail.turnId)
      } else if (detail?.type === 'transcript_received' && detail.transcript) {
        writerStore.syncTranscript(detail.address, detail.transcript)
      }
    }
    window.addEventListener(E2E_RUNTIME_LIFECYCLE_EVENT, handleLifecycleEvent)
    return () => window.removeEventListener(E2E_RUNTIME_LIFECYCLE_EVENT, handleLifecycleEvent)
  }, [writerStore])

  return (
    <RuntimeTaskLifecycleContext.Provider value={store}>
      <RuntimeTaskLifecycleWriterContext.Provider value={writerStore}>
        {children}
      </RuntimeTaskLifecycleWriterContext.Provider>
    </RuntimeTaskLifecycleContext.Provider>
  )
}
