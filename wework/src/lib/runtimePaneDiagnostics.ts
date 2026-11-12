import type { WorkbenchMessage } from '@/types/workbench'
import type { RuntimePaneDebugSnapshot } from './debugPanel'

interface DisplayItemDiagnostic {
  id: string
  type: string
  contentLength: number | null
}

interface PaneTransition {
  observedAt: string
  taskId: string | null
  streaming: boolean
  waiting: boolean
  busy: boolean
  messages: RuntimePaneDebugSnapshot['messageSummary']
}

const transitions: PaneTransition[] = []
let lastSignature = ''

export function summarizeRuntimeDisplayItems(message: WorkbenchMessage): DisplayItemDiagnostic[] {
  return (message.runtimeDisplayItems ?? []).slice(-20).map(item => ({
    id: item.id,
    type: item.type,
    contentLength: item.type === 'assistant_text' ? item.content.length : null,
  }))
}

/** Keep lifecycle evidence from before a failing scenario releases its model response. */
export function recordRuntimePaneTransition(snapshot: RuntimePaneDebugSnapshot): void {
  const state = {
    taskId: snapshot.currentRuntimeTask?.taskId ?? null,
    streaming: snapshot.status.isAssistantStreaming,
    waiting: snapshot.status.isWaitingForAssistantIndicator,
    busy: snapshot.status.isBusy,
    messages: snapshot.messageSummary,
  }
  const signature = JSON.stringify(state)
  if (signature === lastSignature) return
  lastSignature = signature
  transitions.push({ observedAt: snapshot.updatedAt, ...state })
  if (transitions.length > 64) transitions.shift()
}

export const getRuntimePaneTransitions = () => [...transitions]
export function clearRuntimePaneTransitions(): void {
  transitions.length = 0
  lastSignature = ''
}
