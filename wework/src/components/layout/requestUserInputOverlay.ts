import type {
  RequestUserInputPayload,
  RequestUserInputResponse,
  RequestUserInputQuestion,
} from '@wegent/chat-core/runtime'
import {
  CODEX_IMPLEMENT_PLAN_QUESTION,
  CODEX_IMPLEMENT_PLAN_RESPONSE_LABEL,
  isPendingRequestUserInputBlock,
  isAsyncRequestUserInputPayload,
  requestUserInputPayloadKey,
} from '@/components/chat/requestUserInputMessages'
import type { WorkbenchMessage } from '@/types/workbench'
import { isDeliveredRequestUserInputReply } from '@wegent/chat-core/runtime-user-input'

type QuestionTarget = { payload: RequestUserInputPayload; questionId: string }
type GroupedInput = RequestUserInputPayload & { questionTargets?: Record<string, QuestionTarget> }

/** Preserve ownership when asynchronous requests share a form. */
export function requestUserInputQuestionTarget(
  payload: RequestUserInputPayload,
  questionId: string
): QuestionTarget {
  return (payload as GroupedInput).questionTargets?.[questionId] ?? { payload, questionId }
}

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
  const grouped: GroupedInput = {
    ...asyncPayloads[0],
    questionTargets: Object.fromEntries(
      asyncPayloads.flatMap((payload, index) =>
        (payload.questions ?? []).map((question, questionIndex) => [
          groupedQuestionId(payload, question, index, questionIndex),
          { payload, questionId: question.id?.trim() || `question_${questionIndex + 1}` },
        ])
      )
    ),
    questions: asyncPayloads.flatMap((payload, index) => {
      return (payload.questions ?? []).map((question, questionIndex) => ({
        ...question,
        id: groupedQuestionId(payload, question, index, questionIndex),
      }))
    }),
  }
  return grouped
}

function groupedQuestionId(
  payload: RequestUserInputPayload,
  question: RequestUserInputQuestion,
  requestIndex: number,
  questionIndex: number
): string {
  const questionId = question.id?.trim() || `question_${questionIndex + 1}`
  if (requestIndex === 0) return questionId
  const key = requestUserInputPayloadKey(payload) ?? `anonymous:${requestIndex}`
  return JSON.stringify([key, questionId, questionIndex])
}

/** Capture each request and its own answers before asynchronous delivery. */
export function pendingRequestUserInputResponses(
  response: RequestUserInputResponse,
  messages: WorkbenchMessage[],
  hiddenRequestUserInputIds?: ReadonlySet<string>
): RequestUserInputResponse[] {
  const payloads = pendingRequestUserInputPayloads(messages, hiddenRequestUserInputIds)
  if (payloads.length <= 1) return [response]
  return payloads.map((payload, requestIndex) => ({
    requestId: payload.requestId ?? payload.request_id,
    itemId: payload.itemId ?? payload.item_id,
    interactionScope: payload.interactionScope,
    answers: Object.fromEntries(
      (payload.questions ?? []).flatMap((question, questionIndex) => {
        const answer =
          response.answers[groupedQuestionId(payload, question, requestIndex, questionIndex)]
        const id = question.id?.trim() || `question_${questionIndex + 1}`
        return answer ? [[id, answer]] : []
      })
    ),
  }))
}

/** The original requests behind the form, also used to dismiss the whole group. */
export function pendingRequestUserInputPayloads(
  messages: WorkbenchMessage[],
  hiddenRequestUserInputIds?: ReadonlySet<string>
): RequestUserInputPayload[] {
  const asyncPayloads: RequestUserInputPayload[] = []
  let planPayload: RequestUserInputPayload | null = null
  for (const message of [...messages].reverse()) {
    if (isDeliveredRequestUserInputReply(message)) {
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
  if (asyncPayloads.length === 0) return planPayload ? [planPayload] : []
  const seen = new Set<string>()
  return asyncPayloads.filter(payload => {
    const key = requestUserInputPayloadKey(payload)
    if (!key) return true
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
