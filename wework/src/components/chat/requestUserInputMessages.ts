import type { RequestUserInputResponse } from '@/types/api'
import type { ProcessingBlock, ToolBlock, WorkbenchMessage } from '@/types/workbench'
import type { RequestUserInputPayload } from './RequestUserInputCard'

const EMPTY_HIDDEN_REQUEST_USER_INPUT_IDS = new Set<string>()

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

export function isRequestUserInputBlock(block: ProcessingBlock): block is ToolBlock {
  if (block.type !== 'tool') return false
  return isRequestUserInputPayload(block.renderPayload)
}

export function isPendingRequestUserInputBlock(
  block: ProcessingBlock,
  hiddenRequestUserInputIds: ReadonlySet<string> = EMPTY_HIDDEN_REQUEST_USER_INPUT_IDS
): block is ToolBlock {
  if (!isRequestUserInputBlock(block)) return false
  if (block.status === 'done' || block.status === 'error') return false
  return !isHiddenRequestUserInputBlock(block, hiddenRequestUserInputIds)
}

export function isHiddenRequestUserInputBlock(
  block: ProcessingBlock,
  hiddenRequestUserInputIds: ReadonlySet<string>
): boolean {
  if (!isRequestUserInputBlock(block)) return false
  const key = requestUserInputPayloadKey(block.renderPayload as RequestUserInputPayload)
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

function isRequestUserInputPayload(value: unknown): value is RequestUserInputPayload {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === 'request_user_input'
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

function isMatchingRequestUserInputBlock(block: ProcessingBlock, responseKey: string | null) {
  if (!isPendingRequestUserInputBlock(block)) return false
  if (!responseKey) return true
  const payloadKey = requestUserInputPayloadKey(block.renderPayload as RequestUserInputPayload)
  return payloadKey === responseKey
}
