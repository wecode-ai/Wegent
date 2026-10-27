import type { RuntimeGoalStatus, RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'
import type { RuntimePaneTranscript } from '@/types/workbench'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

const E2E_RUNTIME_LIFECYCLE_EVENT = 'wework:e2e:runtime-task-lifecycle'

interface RuntimeTaskLifecycleAutomationEvent {
  address: RuntimeTaskAddress
  type: string
  turnId?: string | null
  transcript?: RuntimePaneTranscript
  goalStatus?: RuntimeGoalStatus | null
  task?: RuntimeTaskSummary
  capture?: (snapshot: ReturnType<RuntimeTaskLifecycleStore['getTask']>) => void
}

export function registerRuntimeTaskLifecycleAutomation(
  store: RuntimeTaskLifecycleStore,
  target: Window = window
): () => void {
  const handleLifecycleEvent = (event: Event) => {
    const detail = (event as CustomEvent<RuntimeTaskLifecycleAutomationEvent>).detail
    if (detail?.type === 'capture_snapshot') {
      detail.capture?.(store.getTask(detail.address))
    } else if (detail?.type === 'turn_settled') {
      store.turnSettled(detail.address, detail.turnId)
    } else if (detail?.type === 'transcript_received' && detail.transcript) {
      store.syncTranscript(detail.address, detail.transcript)
    } else if (detail?.type === 'goal_status_received') {
      store.goalStatusReceived(detail.address, detail.goalStatus ?? null)
    } else if (detail?.type === 'executor_snapshot_received' && detail.task) {
      store.syncRuntimeTask(detail.address, detail.task)
    }
  }
  target.addEventListener(E2E_RUNTIME_LIFECYCLE_EVENT, handleLifecycleEvent)
  return () => target.removeEventListener(E2E_RUNTIME_LIFECYCLE_EVENT, handleLifecycleEvent)
}
