import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import {
  CODEX_IMPLEMENT_PLAN_QUESTION,
  CODEX_IMPLEMENT_PLAN_RESPONSE_LABEL,
  isPendingRequestUserInputBlock,
  isAsyncRequestUserInputPayload,
  requestUserInputPayloadKey,
} from '@/components/chat/requestUserInputMessages'
import type { WorkbenchMessage } from '@/types/workbench'

export function pendingRequestUserInputPayload(
  messages: WorkbenchMessage[],
  hiddenRequestUserInputIds?: ReadonlySet<string>
): RequestUserInputPayload | null {
  const asyncPayloads = pendingRequestUserInputPayloads(messages, hiddenRequestUserInputIds)
  if (asyncPayloads.length === 0) return null
  if (asyncPayloads.length === 1) return asyncPayloads[0]

  // Keep the first request's identity and question IDs stable as new requests
  // arrive, so React preserves the answers already being edited. Later calls
  // can reuse question IDs; scope those IDs to their owning request.
  const seen = new Set<string>()
  return {
    ...asyncPayloads[0],
    questions: asyncPayloads.flatMap((payload, index) => {
      const key = requestUserInputPayloadKey(payload) ?? `anonymous:${index}`
      if (seen.has(key)) return []
      seen.add(key)
      return (payload.questions ?? []).map((question, questionIndex) => ({
        ...question,
        id: index === 0 ? question.id : JSON.stringify([key, question.id, questionIndex]),
      }))
    }),
  }
}

/** The original requests behind the form, also used to dismiss the whole group. */
export function pendingRequestUserInputPayloads(
  messages: WorkbenchMessage[],
  hiddenRequestUserInputIds?: ReadonlySet<string>
): RequestUserInputPayload[] {
  const asyncPayloads: RequestUserInputPayload[] = []
  let planPayload: RequestUserInputPayload | null = null
  for (const message of [...messages].reverse()) {
    if (message.role === 'user' && message.content.trim()) {
      break
    }

    for (const block of [...(message.blocks ?? [])].reverse()) {
      if (!isPendingRequestUserInputBlock(block, hiddenRequestUserInputIds)) continue
      const payload = block.renderPayload
      if (!isAsyncRequestUserInputPayload(payload)) return [payload]
      asyncPayloads.unshift(payload)
    }

    planPayload ??= pendingImplementationPlanPayload(message, hiddenRequestUserInputIds)
  }
  return asyncPayloads.length > 0 ? asyncPayloads : planPayload ? [planPayload] : []
}

function pendingImplementationPlanPayload(
  message: WorkbenchMessage,
  hiddenRequestUserInputIds?: ReadonlySet<string>
): RequestUserInputPayload | null {
  if (message.role !== 'assistant' || message.status === 'streaming') return null

  const planBlock = [...(message.blocks ?? [])]
    .reverse()
    .find(
      block => block.type === 'plan' && block.status === 'done' && Boolean(block.content.trim())
    )
  if (!planBlock) return null

  const itemId = `implementation-plan:${message.id}:${planBlock.id}`
  if (hiddenRequestUserInputIds?.has(`item:${itemId}`)) return null

  return {
    kind: 'request_user_input',
    itemId,
    questions: [
      {
        id: 'implement',
        question: CODEX_IMPLEMENT_PLAN_QUESTION,
        options: [{ label: CODEX_IMPLEMENT_PLAN_RESPONSE_LABEL }],
      },
      {
        id: 'adjustment',
        question: '否，请告知 WeWork 如何调整',
        is_other: true,
      },
    ],
  }
}
