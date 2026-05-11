// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { SubtaskContextBrief } from '@/types/api'
import { parseMarkdownFinalPrompt } from '../message/finalPromptParser'

export type PipelineNextStepDefaultSource = 'final_prompt' | 'last_ai_response' | 'none'

export interface PipelineNextStepMessage {
  id: string
  type: 'user' | 'ai'
  status: 'pending' | 'streaming' | 'completed' | 'error'
  content: string
  timestamp: number
  messageId?: number
  contexts?: SubtaskContextBrief[]
}

export interface PipelineNextStepTextItem {
  id: string
  kind: 'user_message' | 'ai_response' | 'history_message'
  role: 'user' | 'ai'
  content: string
  selectedByDefault: boolean
}

export interface PipelineNextStepStructuredItem {
  id: string
  context: SubtaskContextBrief
  selectedByDefault: boolean
}

export interface PipelineNextStepDraft {
  defaultMessage: string
  defaultSource: PipelineNextStepDefaultSource
  canSubmit: boolean
  textItems: PipelineNextStepTextItem[]
  structuredItems: PipelineNextStepStructuredItem[]
}

export interface PipelineNextStepBackendContext {
  type: 'knowledge_base' | 'table'
  data: Record<string, unknown>
}

export interface PipelineNextStepPayload {
  message: string
  attachmentIds: number[]
  contexts: PipelineNextStepBackendContext[]
  pendingContexts: SubtaskContextBrief[]
}

export interface BuildPipelineNextStepPayloadInput {
  draft: PipelineNextStepDraft
  editedMessage: string
  selectedTextItemIds: string[]
  selectedStructuredItemIds: string[]
}

function sortMessages(messages: PipelineNextStepMessage[]): PipelineNextStepMessage[] {
  return [...messages].sort((left, right) => {
    if (left.messageId !== undefined && right.messageId !== undefined) {
      if (left.messageId !== right.messageId) {
        return left.messageId - right.messageId
      }

      return left.timestamp - right.timestamp
    }

    if (left.messageId !== undefined) return -1
    if (right.messageId !== undefined) return 1

    return left.timestamp - right.timestamp
  })
}

function hasCompletedContent(message: PipelineNextStepMessage): boolean {
  return message.status === 'completed' && message.content.trim().length > 0
}

function buildTextItemId(message: PipelineNextStepMessage, kind: PipelineNextStepTextItem['kind']) {
  return `${kind}:${message.id}`
}

function getStructuredItemId(context: SubtaskContextBrief): string | null {
  if (context.context_type === 'attachment') {
    return `attachment:${context.id}`
  }

  if (context.context_type === 'knowledge_base' && context.knowledge_id) {
    return `knowledge_base:${context.knowledge_id}`
  }

  if (context.context_type === 'table' && context.document_id) {
    return `table:${context.document_id}`
  }

  return null
}

function findSelectedAiMessage(
  messages: PipelineNextStepMessage[]
): PipelineNextStepMessage | undefined {
  return [...messages]
    .reverse()
    .find(message => message.type === 'ai' && hasCompletedContent(message))
}

function findPrecedingUserMessage(
  messages: PipelineNextStepMessage[],
  selectedAiMessage: PipelineNextStepMessage
): PipelineNextStepMessage | undefined {
  const selectedIndex = messages.findIndex(message => message.id === selectedAiMessage.id)
  if (selectedIndex <= 0) return undefined

  return messages
    .slice(0, selectedIndex)
    .reverse()
    .find(message => message.type === 'user' && hasCompletedContent(message))
}

function getDefaultMessage(selectedAiMessage: PipelineNextStepMessage): {
  message: string
  source: PipelineNextStepDefaultSource
} {
  const parsedFinalPrompt = parseMarkdownFinalPrompt(selectedAiMessage.content)
  const finalPrompt = parsedFinalPrompt?.final_prompt.trim()

  if (finalPrompt) {
    return {
      message: finalPrompt,
      source: 'final_prompt',
    }
  }

  return {
    message: selectedAiMessage.content.trim(),
    source: 'last_ai_response',
  }
}

function collectStructuredItems(
  messages: Array<PipelineNextStepMessage | undefined>
): PipelineNextStepStructuredItem[] {
  const seen = new Set<string>()
  const items: PipelineNextStepStructuredItem[] = []

  for (const message of messages) {
    for (const context of message?.contexts ?? []) {
      const key = getStructuredItemId(context)
      if (!key) continue

      if (seen.has(key)) continue

      seen.add(key)
      items.push({
        id: key,
        context,
        selectedByDefault: true,
      })
    }
  }

  return items
}

function buildTextItems(
  messages: PipelineNextStepMessage[],
  selectedAiMessage: PipelineNextStepMessage,
  precedingUserMessage: PipelineNextStepMessage | undefined,
  selectedAiContent: string
): PipelineNextStepTextItem[] {
  const items: PipelineNextStepTextItem[] = []

  for (const message of messages) {
    if (!hasCompletedContent(message)) continue

    if (message.id === selectedAiMessage.id) {
      items.push({
        id: buildTextItemId(message, 'ai_response'),
        kind: 'ai_response',
        role: 'ai',
        content: selectedAiContent,
        selectedByDefault: true,
      })
      continue
    }

    const kind = message.id === precedingUserMessage?.id ? 'user_message' : 'history_message'

    items.push({
      id: buildTextItemId(message, kind),
      kind,
      role: message.type,
      content: message.content.trim(),
      selectedByDefault: false,
    })
  }

  return items
}

export function buildPipelineNextStepDraft(
  messages: PipelineNextStepMessage[]
): PipelineNextStepDraft {
  const sortedMessages = sortMessages(messages)
  const selectedAiMessage = findSelectedAiMessage(sortedMessages)

  if (!selectedAiMessage) {
    return {
      defaultMessage: '',
      defaultSource: 'none',
      canSubmit: false,
      textItems: [],
      structuredItems: [],
    }
  }

  const defaultResult = getDefaultMessage(selectedAiMessage)
  const precedingUserMessage = findPrecedingUserMessage(sortedMessages, selectedAiMessage)
  const textItems = buildTextItems(
    sortedMessages,
    selectedAiMessage,
    precedingUserMessage,
    defaultResult.message
  )
  const structuredItems = collectStructuredItems([precedingUserMessage, selectedAiMessage])

  return {
    defaultMessage: '',
    defaultSource: defaultResult.source,
    canSubmit:
      textItems.some(item => item.selectedByDefault) ||
      structuredItems.some(item => item.selectedByDefault),
    textItems,
    structuredItems,
  }
}

function appendSelectedText(message: string, selectedItems: PipelineNextStepTextItem[]): string {
  const contextText = selectedItems
    .map(item => {
      const content = item.content.trim()
      if (!content) return ''

      return `[${item.role === 'user' ? 'User' : 'AI'}]\n${content}`
    })
    .filter(Boolean)

  if (contextText.length === 0) {
    return message.trim()
  }

  return [message.trim(), ['Previous pipeline context:', ...contextText].join('\n\n')]
    .filter(Boolean)
    .join('\n\n')
}

function toBackendContext(
  context: SubtaskContextBrief
): PipelineNextStepBackendContext | undefined {
  if (context.context_type === 'knowledge_base') {
    if (!context.knowledge_id) {
      return undefined
    }

    return {
      type: 'knowledge_base',
      data: {
        knowledge_id: context.knowledge_id,
        name: context.name,
        document_count: context.document_count,
      },
    }
  }

  if (context.context_type === 'table') {
    if (!context.document_id) {
      return undefined
    }

    return {
      type: 'table',
      data: {
        document_id: context.document_id,
        name: context.name,
        source_config: context.source_config,
      },
    }
  }

  return undefined
}

export function buildPipelineNextStepPayload(
  input: BuildPipelineNextStepPayloadInput
): PipelineNextStepPayload {
  const selectedTextItemIds = new Set(input.selectedTextItemIds)
  const selectedStructuredItemIds = new Set(input.selectedStructuredItemIds)
  const selectedTextItems = input.draft.textItems.filter(item => selectedTextItemIds.has(item.id))
  const selectedStructuredItems = input.draft.structuredItems.filter(item =>
    selectedStructuredItemIds.has(item.id)
  )

  const attachmentIds: number[] = []
  const contexts: PipelineNextStepBackendContext[] = []
  const pendingContexts: SubtaskContextBrief[] = []

  for (const item of selectedStructuredItems) {
    pendingContexts.push(item.context)

    if (item.context.context_type === 'attachment') {
      attachmentIds.push(item.context.id)
      continue
    }

    const backendContext = toBackendContext(item.context)
    if (backendContext) {
      contexts.push(backendContext)
    }
  }

  return {
    message: appendSelectedText(input.editedMessage, selectedTextItems),
    attachmentIds,
    contexts,
    pendingContexts,
  }
}
