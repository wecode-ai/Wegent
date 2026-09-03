import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import i18n from '@/i18n'
import type { RuntimeTaskLifecycleSnapshot } from './runtimeTaskLifecycle'

export type RuntimePaneSendPhase = 'idle' | 'submitting' | 'awaiting_assistant'

export interface RuntimePaneStatus {
  sendPhase: RuntimePaneSendPhase
  workspaceCreationKind?: string
  activeAssistantMessage: WorkbenchMessage | null
  taskExecution: {
    known: boolean
    running: boolean
    continuable: boolean
    status: string | null
  }
  isSubmitting: boolean
  isAwaitingAssistant: boolean
  isAssistantStreaming: boolean
  isResponseActive: boolean
  isBusy: boolean
  isWaitingForAssistantIndicator: boolean
  canSendQueuedMessage: boolean
}

export function isRuntimeTaskBusyError(error: string | null): boolean {
  const normalizedError = error?.trim().toLowerCase()
  return (
    normalizedError?.includes('runtime task is already running') === true ||
    normalizedError === i18n.t('workbench.runtime_task_running_message').trim().toLowerCase()
  )
}

export function deriveRuntimePaneStatus({
  messages,
  currentRuntimeTask,
  lifecycle,
}: {
  messages: WorkbenchMessage[]
  currentRuntimeTask: RuntimeTaskAddress | null
  lifecycle: RuntimeTaskLifecycleSnapshot | null
}): RuntimePaneStatus {
  const turnPhase = lifecycle?.turn.phase ?? 'idle'
  const sendPhase: RuntimePaneSendPhase =
    turnPhase === 'submitting'
      ? 'submitting'
      : turnPhase === 'awaiting'
        ? 'awaiting_assistant'
        : 'idle'
  const activeAssistantMessage =
    turnPhase === 'streaming' ? (findActiveAssistantMessage(messages) ?? null) : null
  const isSubmitting = turnPhase === 'submitting'
  const isAwaitingAssistant = turnPhase === 'awaiting'
  const isAssistantStreaming = turnPhase === 'streaming'
  const isResponseActive = lifecycle?.derived.isTurnActive ?? false
  const isBusy = lifecycle?.derived.isBusy ?? false
  const running = lifecycle?.derived.isRunning ?? false
  const continuable = lifecycle?.continuable ?? false

  return {
    sendPhase,
    ...(lifecycle?.workspaceCreationKind
      ? { workspaceCreationKind: lifecycle.workspaceCreationKind }
      : {}),
    activeAssistantMessage,
    taskExecution: {
      known: lifecycle?.execution.known ?? false,
      running,
      continuable,
      status: lifecycle?.task?.status?.trim().toLowerCase() || null,
    },
    isSubmitting,
    isAwaitingAssistant,
    isAssistantStreaming,
    isResponseActive,
    isBusy,
    isWaitingForAssistantIndicator:
      isSubmitting || isAwaitingAssistant || (running && !activeAssistantMessage),
    canSendQueuedMessage: Boolean(currentRuntimeTask) && continuable && !isBusy,
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
