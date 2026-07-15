import type { RuntimeTaskSummary, RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { findRuntimeTask } from './workbenchRuntimeHelpers'

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
  const task = findRuntimeTask(runtimeWork, address)
  if (!task) {
    return { known: false, running: false, status: null }
  }

  const running = typeof task.running === 'boolean' ? task.running : null
  return {
    known: running !== null,
    running: running === true,
    status: normalizeTaskStatus(task),
  }
}

export function hasRunningRuntimeTask(
  runtimeWork: RuntimeWorkListResponse | null | undefined
): boolean {
  if (!runtimeWork) return false

  return [
    ...runtimeWork.chats,
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
  ]
    .flatMap(workspace => workspace.tasks)
    .some(task => task.running === true)
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
  const messageStreamingCanDriveExecution = !taskExecution.known || taskExecution.running
  const activeAssistantMessage = messageStreamingCanDriveExecution
    ? (findActiveAssistantMessage(messages) ?? null)
    : null
  const isSubmitting = sendPhase === 'submitting'
  const isAwaitingAssistant = sendPhase === 'awaiting_assistant'
  const isAssistantStreaming = Boolean(activeAssistantMessage)
  const isResponseActive = isAwaitingAssistant || isAssistantStreaming
  const isBusy = isSubmitting || isResponseActive || taskExecution.running
  const isWaitingForAssistantMessage =
    !isAssistantStreaming && isLastMessageWaitingForAssistant(messages)

  return {
    sendPhase,
    activeAssistantMessage,
    taskExecution,
    isSubmitting,
    isAwaitingAssistant,
    isAssistantStreaming,
    isResponseActive,
    isBusy,
    isWaitingForAssistantIndicator:
      (isSubmitting || isAwaitingAssistant || taskExecution.running) &&
      isWaitingForAssistantMessage,
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

function normalizeTaskStatus(task: RuntimeTaskSummary): string | null {
  return task.status?.trim().toLowerCase() || null
}

function isLastMessageWaitingForAssistant(messages: WorkbenchMessage[]): boolean {
  const lastMessage = [...messages].reverse().find(message => message.role !== 'system')
  return !lastMessage || lastMessage.role === 'user' || lastMessage.status === 'failed'
}
