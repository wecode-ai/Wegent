import type { RequestUserInputResponse } from '@/types/api'
import type { ProcessingBlock, ToolBlock, WorkbenchMessage } from '@/types/workbench'
import type { RequestUserInputPayload } from './RequestUserInputCard'

const EMPTY_HIDDEN_REQUEST_USER_INPUT_IDS = new Set<string>()
export const CODEX_IMPLEMENT_PLAN_QUESTION = '执行此计划?'
export const CODEX_IMPLEMENT_PLAN_RESPONSE_LABEL = '是的，执行此计划'
const IMPLEMENT_PLAN_TEXT_MARKERS = ['实施此计划', '执行此计划']

export function hasImplementationPlanText(text: string | null | undefined): boolean {
  const normalizedText = text?.trim()
  return Boolean(
    normalizedText && IMPLEMENT_PLAN_TEXT_MARKERS.some(marker => normalizedText.includes(marker))
  )
}

export type RequestUserInputBlock = ToolBlock & {
  renderPayload: RequestUserInputPayload
}

export function requestUserInputPayloadKey(
  payload: RequestUserInputPayload | null | undefined
): string | null {
  const requestId = payload?.requestId ?? payload?.request_id
  if (requestId !== undefined && requestId !== null && String(requestId).trim()) {
    return `request:${String(requestId)}`
  }

  const itemId = payload?.itemId ?? payload?.item_id
  if (itemId !== undefined && itemId !== null && String(itemId).trim()) {
    return `item:${String(itemId)}`
  }

  return null
}

export function requestUserInputResponseKey(response: RequestUserInputResponse): string | null {
  const requestId = response.requestId ?? response.request_id
  if (requestId !== undefined && requestId !== null && String(requestId).trim()) {
    return `request:${String(requestId)}`
  }

  const itemId = response.itemId ?? response.item_id
  if (itemId !== undefined && itemId !== null && String(itemId).trim()) {
    return `item:${String(itemId)}`
  }

  return null
}

export function isImplementationPlanRequestUserInput(
  payload: RequestUserInputPayload | null | undefined
): boolean {
  const questions = Array.isArray(payload?.questions) ? payload.questions : []
  return questions.some(question => {
    const id = question.id?.trim().toLowerCase()
    const text = question.question?.trim()
    if (id === 'implement') return true
    if (hasImplementationPlanText(text)) return true
    return question.options?.some(option => hasImplementationPlanText(option.label)) ?? false
  })
}

export function isRequestUserInputBlock(block: ProcessingBlock): block is RequestUserInputBlock {
  if (block.type !== 'tool') return false
  return isRequestUserInputPayload(block.renderPayload)
}

export function isPendingRequestUserInputBlock(
  block: ProcessingBlock,
  hiddenRequestUserInputIds: ReadonlySet<string> = EMPTY_HIDDEN_REQUEST_USER_INPUT_IDS
): block is RequestUserInputBlock {
  if (!isRequestUserInputBlock(block)) return false
  if (block.status === 'error') return false
  if (hasRequestUserInputResponse(block.renderPayload)) return false
  return !isHiddenRequestUserInputBlock(block, hiddenRequestUserInputIds)
}

export function isAnsweredRequestUserInputBlock(block: ProcessingBlock): boolean {
  if (!isRequestUserInputBlock(block)) return false
  return hasRequestUserInputResponse(block.renderPayload)
}

export function isHiddenRequestUserInputBlock(
  block: ProcessingBlock,
  hiddenRequestUserInputIds: ReadonlySet<string>
): boolean {
  if (!isRequestUserInputBlock(block)) return false
  const key = requestUserInputPayloadKey(block.renderPayload)
  return Boolean(key && hiddenRequestUserInputIds.has(key))
}

export function insertUserMessageBeforeRequestUserInput(
  messages: WorkbenchMessage[],
  userMessage: WorkbenchMessage,
  response: RequestUserInputResponse
): WorkbenchMessage[] {
  const responseKey = requestUserInputResponseKey(response)
  const targetIndex = findRequestUserInputMessageIndex(messages, responseKey)
  if (targetIndex < 0) {
    return [...messages, userMessage]
  }

  return [...messages.slice(0, targetIndex), userMessage, ...messages.slice(targetIndex)]
}

export function applyRequestUserInputResponseToMessages(
  messages: WorkbenchMessage[],
  response: RequestUserInputResponse
): WorkbenchMessage[] {
  const responseKey = requestUserInputResponseKey(response)
  let didUpdate = false

  const nextMessages = messages.map(message => {
    if (message.role !== 'assistant' || !message.blocks?.length) return message

    let messageUpdated = false
    const nextBlocks = message.blocks.map(block => {
      if (!isMatchingRequestUserInputBlock(block, responseKey)) return block
      didUpdate = true
      messageUpdated = true
      return {
        ...block,
        status: 'done' as const,
        renderPayload: {
          ...block.renderPayload,
          response,
        },
      }
    })

    return messageUpdated ? { ...message, blocks: nextBlocks } : message
  })

  return didUpdate ? nextMessages : messages
}

function isRequestUserInputPayload(value: unknown): value is RequestUserInputPayload {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === 'request_user_input'
  )
}

export function hasRequestUserInputResponse(payload: RequestUserInputPayload): boolean {
  return Boolean(
    payload.response ?? payload.requestUserInputResponse ?? payload.request_user_input_response
  )
}

function findRequestUserInputMessageIndex(
  messages: WorkbenchMessage[],
  responseKey: string | null
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    if (!message.blocks?.some(block => isMatchingRequestUserInputBlock(block, responseKey))) {
      continue
    }
    return index
  }
  return -1
}

function isMatchingRequestUserInputBlock(
  block: ProcessingBlock,
  responseKey: string | null
): block is RequestUserInputBlock {
  if (!isPendingRequestUserInputBlock(block)) return false
  if (!responseKey) return true
  const payloadKey = requestUserInputPayloadKey(block.renderPayload)
  return payloadKey === responseKey
}
