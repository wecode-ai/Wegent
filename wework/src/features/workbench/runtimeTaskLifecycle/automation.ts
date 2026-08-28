import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimePaneTranscript } from '@/types/workbench'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

const E2E_RUNTIME_LIFECYCLE_EVENT = 'wework:e2e:runtime-task-lifecycle'

interface RuntimeTaskLifecycleAutomationEvent {
  address: RuntimeTaskAddress
  type: string
  turnId?: string | null
  transcript?: RuntimePaneTranscript
}

export function registerRuntimeTaskLifecycleAutomation(
  store: RuntimeTaskLifecycleStore,
  target: Window = window
): () => void {
  const handleLifecycleEvent = (event: Event) => {
    const detail = (event as CustomEvent<RuntimeTaskLifecycleAutomationEvent>).detail
    if (detail?.type === 'turn_settled') {
      store.turnSettled(detail.address, detail.turnId)
    } else if (detail?.type === 'transcript_received' && detail.transcript) {
      store.syncTranscript(detail.address, detail.transcript)
    }
  }
  target.addEventListener(E2E_RUNTIME_LIFECYCLE_EVENT, handleLifecycleEvent)
  return () => target.removeEventListener(E2E_RUNTIME_LIFECYCLE_EVENT, handleLifecycleEvent)
}
