// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type ChatPrimaryAction = 'send' | 'queue' | 'stop' | 'cancel' | 'loading'

interface ChatSendStateInput {
  isLoading: boolean
  isStreaming: boolean
  isAwaitingResponseStart: boolean
  isStopping: boolean
  isModelSelectionRequired: boolean
  isAttachmentReadyToSend: boolean
  hasNoTeams: boolean
  shouldHideChatInput: boolean
  taskInputMessage: string
  hasAttachments?: boolean
  selectedTaskStatus?: string | null
  isSubtaskStreaming: boolean
  isGroupChat?: boolean
  canQueueMessage?: boolean
}

export interface ChatSendState {
  primaryAction: ChatPrimaryAction
  isPrimaryDisabled: boolean
  showStopAction: boolean
  showPendingAction: boolean
}

export function getChatSendState(input: ChatSendStateInput): ChatSendState {
  const hasTextContent = input.taskInputMessage.trim().length > 0
  const hasUserProvidedContent = hasTextContent || Boolean(input.hasAttachments)
  const hasSendableContent = input.shouldHideChatInput || hasUserProvidedContent
  const baseDisabled =
    input.isLoading ||
    input.isModelSelectionRequired ||
    !input.isAttachmentReadyToSend ||
    input.hasNoTeams ||
    !hasSendableContent
  const isActiveStream = input.isStreaming || input.isAwaitingResponseStart || input.isStopping

  if (input.isStopping) {
    return {
      primaryAction: 'loading',
      isPrimaryDisabled: true,
      showStopAction: true,
      showPendingAction: false,
    }
  }

  if (isActiveStream && input.canQueueMessage && hasUserProvidedContent && !baseDisabled) {
    return {
      primaryAction: 'queue',
      isPrimaryDisabled: false,
      showStopAction: true,
      showPendingAction: false,
    }
  }

  if (isActiveStream) {
    return {
      primaryAction: 'stop',
      isPrimaryDisabled: false,
      showStopAction: true,
      showPendingAction: false,
    }
  }

  if (input.selectedTaskStatus === 'PENDING' && !input.isSubtaskStreaming && input.isGroupChat) {
    return {
      primaryAction: 'send',
      isPrimaryDisabled: baseDisabled,
      showStopAction: false,
      showPendingAction: false,
    }
  }

  if (input.selectedTaskStatus === 'PENDING') {
    return {
      primaryAction: 'cancel',
      isPrimaryDisabled: false,
      showStopAction: false,
      showPendingAction: false,
    }
  }

  if (input.selectedTaskStatus === 'CANCELLING') {
    return {
      primaryAction: 'loading',
      isPrimaryDisabled: true,
      showStopAction: true,
      showPendingAction: false,
    }
  }

  return {
    primaryAction: 'send',
    isPrimaryDisabled: baseDisabled,
    showStopAction: false,
    showPendingAction: false,
  }
}
