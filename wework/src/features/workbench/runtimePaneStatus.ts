import type { LocalTaskSummary, RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { findRuntimeLocalTask } from './workbenchRuntimeHelpers'

export type RuntimePaneSendPhase = 'idle' | 'submitting' | 'awaiting_assistant'

export interface RuntimePaneTaskExecution {
  known: boolean
  running: boolean
  status: string | null
}

export interface RuntimePaneStatus {
  sendPhase: RuntimePaneSendPhase
  activeAssistantMessage: WorkbenchMessage | null
  taskExecution: RuntimePaneTaskExecution
  isSubmitting: boolean
  isAwaitingAssistant: boolean
  isAssistantStreaming: boolean
  isResponseActive: boolean
  isBusy: boolean
  isWaitingForAssistantIndicator: boolean
  canSendQueuedMessage: boolean
}

export function getRuntimePaneTaskExecution(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress | null | undefined
): RuntimePaneTaskExecution {
  const task = findRuntimeLocalTask(runtimeWork, address)
  if (!task) {
    return { known: false, running: false, status: null }
  }

  return {
    known: true,
    running: task.running === true,
    status: normalizeTaskStatus(task),
  }
}

export function deriveRuntimePaneStatus({
  messages,
  sendPhase,
  currentRuntimeTask,
  taskExecution,
}: {
  messages: WorkbenchMessage[]
  sendPhase: RuntimePaneSendPhase
  currentRuntimeTask: RuntimeTaskAddress | null
  taskExecution: RuntimePaneTaskExecution
}): RuntimePaneStatus {
  const activeAssistantMessage = findActiveAssistantMessage(messages) ?? null
  const isSubmitting = sendPhase === 'submitting'
  const isAwaitingAssistant = sendPhase === 'awaiting_assistant'
  const isAssistantStreaming = Boolean(activeAssistantMessage)
  const isResponseActive = isAwaitingAssistant || isAssistantStreaming
  const isBusy = isSubmitting || isResponseActive || taskExecution.running

  return {
    sendPhase,
    activeAssistantMessage,
    taskExecution,
    isSubmitting,
    isAwaitingAssistant,
    isAssistantStreaming,
    isResponseActive,
    isBusy,
    isWaitingForAssistantIndicator: isSubmitting || isAwaitingAssistant,
    canSendQueuedMessage: Boolean(currentRuntimeTask) && !isBusy,
  }
}

export function findActiveAssistantMessage(
  messages: WorkbenchMessage[]
): WorkbenchMessage | undefined {
  return [...messages]
    .reverse()
    .find(message => message.role === 'assistant' && message.status === 'streaming')
}

export function hasSettledAssistantMessage(messages: WorkbenchMessage[]): boolean {
  return (
    messages.some(message => message.role === 'assistant') && !findActiveAssistantMessage(messages)
  )
}

function normalizeTaskStatus(task: LocalTaskSummary): string | null {
  return task.status?.trim().toLowerCase() || null
}
