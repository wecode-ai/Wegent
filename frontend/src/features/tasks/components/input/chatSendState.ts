// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type ChatPrimaryAction = 'send' | 'queue' | 'stop' | 'cancel' | 'loading'

interface ChatSendStateInput {
  isStreaming: boolean
  isStopping: boolean
  isModelSelectionRequired: boolean
  isAttachmentReadyToSend: boolean
  hasNoTeams: boolean
  shouldHideChatInput: boolean
  taskInputMessage: string
  hasAttachments?: boolean
  canQueueMessage?: boolean
  canCancelTask?: boolean
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
  const sendDisabled =
    input.isModelSelectionRequired ||
    !input.isAttachmentReadyToSend ||
    input.hasNoTeams ||
    !hasSendableContent
  const queueDisabled =
    input.isModelSelectionRequired ||
    !input.isAttachmentReadyToSend ||
    input.hasNoTeams ||
    !hasUserProvidedContent
  const isActiveStream = input.isStreaming || input.isStopping

  if (input.isStopping) {
    return {
      primaryAction: 'loading',
      isPrimaryDisabled: true,
      showStopAction: true,
      showPendingAction: false,
    }
  }

  if (isActiveStream && input.canQueueMessage && !queueDisabled) {
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

  if (input.canCancelTask) {
    return {
      primaryAction: 'cancel',
      isPrimaryDisabled: false,
      showStopAction: false,
      showPendingAction: false,
    }
  }

  return {
    primaryAction: 'send',
    isPrimaryDisabled: sendDisabled,
    showStopAction: false,
    showPendingAction: false,
  }
}
