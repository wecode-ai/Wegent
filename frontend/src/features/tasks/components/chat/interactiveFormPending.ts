// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { InteractiveFormAnswerPayload } from '@/types/api'

const INTERACTIVE_FORM_TYPE = 'interactive_form_question'

export interface PendingInteractiveForm {
  askId: string
  toolUseId: string
  taskId: number
  subtaskId: number
}

interface MessageLike {
  id?: string
  type?: string
  content?: string
  subtaskId?: number
  result?: {
    blocks?: unknown[]
  }
}

const parseRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const getPendingFormFromBlock = (block: unknown): PendingInteractiveForm | null => {
  const blockRecord = parseRecord(block)
  if (!blockRecord) return null

  const toolName = String(blockRecord.tool_name ?? '')
  if (!toolName.includes(INTERACTIVE_FORM_TYPE)) return null

  const renderPayload = parseRecord(blockRecord.render_payload)
  if (renderPayload?.type !== INTERACTIVE_FORM_TYPE) return null

  const questions = renderPayload.questions
  if (!Array.isArray(questions) || questions.length === 0) return null

  const askId = typeof renderPayload.ask_id === 'string' ? renderPayload.ask_id : ''
  const toolUseId =
    typeof blockRecord.tool_use_id === 'string'
      ? blockRecord.tool_use_id
      : typeof blockRecord.id === 'string'
        ? blockRecord.id
        : ''
  const taskId = typeof renderPayload.task_id === 'number' ? renderPayload.task_id : 0
  const subtaskId = typeof renderPayload.subtask_id === 'number' ? renderPayload.subtask_id : 0

  if (!askId || !toolUseId) return null

  return {
    askId,
    toolUseId,
    taskId,
    subtaskId,
  }
}

export const findPendingInteractiveForm = (
  messages: Iterable<MessageLike> | null | undefined
): PendingInteractiveForm | null => {
  if (!messages) return null

  const orderedMessages = Array.from(messages)
  for (let index = orderedMessages.length - 1; index >= 0; index--) {
    const message = orderedMessages[index]
    if (message.type === 'user') {
      return null
    }

    const blocks = message.result?.blocks
    if (!Array.isArray(blocks)) continue

    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const pendingForm = getPendingFormFromBlock(blocks[blockIndex])
      if (pendingForm) return pendingForm
    }
  }

  return null
}

export const buildInteractiveFormCancellation = (
  form: PendingInteractiveForm,
  message: string
): { message: string; answer: InteractiveFormAnswerPayload } => {
  const normalizedMessage = message.trim()

  return {
    message: normalizedMessage,
    answer: {
      type: INTERACTIVE_FORM_TYPE,
      ask_id: form.askId,
      tool_use_id: form.toolUseId,
      task_id: form.taskId,
      subtask_id: form.subtaskId,
      success: false,
      status: 'cancelled',
      answers: {},
      message: normalizedMessage,
    },
  }
}
