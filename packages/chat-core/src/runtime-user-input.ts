import type {
  RequestUserInputResponse,
  RequestUserInputPayload,
  TurnFileChangesSummary,
} from './runtime'
import type {
  WorkbenchMessage,
  WorkbenchProcessingBlock,
  WorkbenchToolBlock as ToolBlock,
} from './workbench-message-reducer'
type ProcessingBlock = WorkbenchProcessingBlock<TurnFileChangesSummary>

const EMPTY_HIDDEN_REQUEST_USER_INPUT_IDS = new Set<string>()
export const CODEX_IMPLEMENT_PLAN_QUESTION = '执行此计划?'
export const CODEX_IMPLEMENT_PLAN_RESPONSE_LABEL = '是的，执行此计划'
export const ASYNC_REQUEST_USER_INPUT_DELIVERY = 'async'
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

export function requestUserInputResponseText(response: RequestUserInputResponse): string {
  const answers = Object.values(response.answers)
    .flatMap(answer => answer.answers)
    .map(answer => answer.trim())
    .filter(Boolean)
  return answers.length > 0 ? answers.join('\n') : '继续'
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

export function isImplementationPlanConfirmationResponse(
  response: RequestUserInputResponse | null | undefined
): boolean {
  const answers = response?.answers
  if (!answers || typeof answers !== 'object') return false

  return Object.values(answers).some(answer => {
    if (!answer || typeof answer !== 'object') return false
    const values = (answer as { answers?: unknown }).answers
    if (!Array.isArray(values)) return false
    return values.some(value => hasImplementationPlanText(String(value)))
  })
}

export function isRequestUserInputBlock(block: ProcessingBlock): block is RequestUserInputBlock {
  if (block.type !== 'tool') return false
  return isRequestUserInputPayload(block.renderPayload)
}

/**
 * Codex's non-blocking `request_user_input_async` question. The tool returns
 * immediately, so the answer arrives as the next user message instead of a
 * runtime response.
 */
export function isAsyncRequestUserInputPayload(
  payload: RequestUserInputPayload | null | undefined
): boolean {
  return payload?.delivery === ASYNC_REQUEST_USER_INPUT_DELIVERY
}

/**
 * Async questions are answered by the next user message, so their response is
 * derived from the conversation rather than from a runtime answer. Without this,
 * a question the user answered in the composer re-opens as a stale prompt.
 */
export function resolveAsyncRequestUserInputAnswers<TAttachment, TFileChanges>(
  messages: WorkbenchMessage<TAttachment, TFileChanges>[]
): WorkbenchMessage<TAttachment, TFileChanges>[] {
  const replyByIndex = asyncReplyByMessageIndex(messages)
  let changed = false
  const resolved = messages.map((message, index) => {
    const reply = replyByIndex[index]
    if (!reply) return message
    const blocks = message.blocks?.map(block => resolveAsyncBlock(block, reply))
    if (!blocks || blocks.every((block, blockIndex) => block === message.blocks![blockIndex])) {
      return message
    }
    changed = true
    return { ...message, blocks }
  })
  return changed ? resolved : messages
}

export interface AsyncRequestUserInputReply {
  question: string
  answer: string
}

/**
 * What each non-blocking answer said, keyed by the reply message id.
 *
 * An async question is answered by the next user message (that delivery is what
 * keeps the model moving), so the transcript recovers the question/answer pairs
 * from the conversation instead of from a runtime response. A reply that cannot
 * be attributed to its questions is left out, and the message renders as typed.
 */
export function resolveAsyncRequestUserInputReplies<TAttachment, TFileChanges>(
  messages: WorkbenchMessage<TAttachment, TFileChanges>[]
): Map<string, AsyncRequestUserInputReply[]> {
  const replies = new Map<string, AsyncRequestUserInputReply[]>()
  messages.forEach((message, index) => {
    const questions = asyncQuestionPrompts(message)
    if (questions.length === 0) return
    const reply = messages.slice(index + 1).find(isUserReply)
    if (!reply) return
    const rows = pairQuestionsWithReply(questions, reply.content)
    if (rows.length > 0) replies.set(reply.id, rows)
  })
  return replies
}

function asyncQuestionPrompts<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>
): string[] {
  return (message.blocks ?? []).flatMap(block => {
    if (block.type !== 'tool') return []
    const payload = block.renderPayload
    if (!isRequestUserInputPayload(payload) || !isAsyncRequestUserInputPayload(payload)) {
      return []
    }
    return (payload.questions ?? []).map(
      (question, index) =>
        question.question?.trim() || question.id?.trim() || `question_${index + 1}`
    )
  })
}

/**
 * Answers are composed one per line in question order, so a reply with as many
 * lines as questions maps line to question. A single question answers with its
 * whole reply; anything else is left unattributed.
 */
function pairQuestionsWithReply(
  questions: string[],
  reply: string
): AsyncRequestUserInputReply[] {
  if (questions.length === 1) {
    const answer = reply.trim()
    return answer ? [{ question: questions[0], answer }] : []
  }
  const lines = reply
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length !== questions.length) return []
  return questions.map((question, index) => ({ question, answer: lines[index] }))
}

function resolveAsyncBlock<TFileChanges>(
  block: WorkbenchProcessingBlock<TFileChanges>,
  reply: string
): WorkbenchProcessingBlock<TFileChanges> {
  if (block.type !== 'tool') return block
  const payload = block.renderPayload
  if (!isRequestUserInputPayload(payload)) return block
  if (!isAsyncRequestUserInputPayload(payload) || hasRequestUserInputResponse(payload)) {
    return block
  }
  return {
    ...block,
    status: 'done',
    renderPayload: {
      ...payload,
      response: asyncRequestUserInputResponse(payload, reply),
    },
  }
}

function asyncReplyByMessageIndex(messages: WorkbenchMessage[]): (string | null)[] {
  const replies: (string | null)[] = new Array(messages.length).fill(null)
  let reply: string | null = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    replies[index] = reply
    if (isUserReply(messages[index])) reply = messages[index].content
  }
  return replies
}

/** The user message that answers a preceding question, whenever the composer sent it. */
function isUserReply(message: WorkbenchMessage): boolean {
  return message.role === 'user' && Boolean(message.content.trim())
}

/** A single free-form reply answers every question the async card asked. */
function asyncRequestUserInputResponse(
  payload: RequestUserInputPayload,
  reply: string
): RequestUserInputResponse {
  return {
    requestId: payload.requestId ?? payload.request_id,
    itemId: payload.itemId ?? payload.item_id,
    answers: Object.fromEntries(
      (payload.questions ?? []).map((question, index) => [
        question.id?.trim() || `question_${index + 1}`,
        { answers: [reply] },
      ])
    ),
  }
}

/** Finds the question a runtime answer belongs to so its delivery mode can win. */
export function findRequestUserInputPayload<TAttachment, TFileChanges>(
  messages: WorkbenchMessage<TAttachment, TFileChanges>[],
  key: string | null
): RequestUserInputPayload | null {
  if (!key) return null
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type !== 'tool') continue
      const payload = block.renderPayload
      if (!isRequestUserInputPayload(payload)) continue
      if (requestUserInputPayloadKey(payload) === key) return payload
    }
  }
  return null
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

export function applyRequestUserInputResponseToBlock(
  block: ProcessingBlock,
  response: RequestUserInputResponse
): ProcessingBlock {
  const responseKey = requestUserInputResponseKey(response)
  if (!isMatchingRequestUserInputBlock(block, responseKey)) return block
  return {
    ...block,
    status: 'done',
    renderPayload: {
      ...block.renderPayload,
      response,
    },
  }
}

/** A history refresh must not reopen a question already accepted by the runtime. */
export function preserveRequestUserInputResponse(
  local: ProcessingBlock,
  snapshot: ProcessingBlock
): ProcessingBlock {
  if (!isRequestUserInputBlock(local) || !isRequestUserInputBlock(snapshot)) return snapshot
  if (
    requestUserInputPayloadKey(local.renderPayload) !==
    requestUserInputPayloadKey(snapshot.renderPayload)
  )
    return snapshot
  const response =
    local.renderPayload.response ??
    local.renderPayload.requestUserInputResponse ??
    local.renderPayload.request_user_input_response
  return response ? applyRequestUserInputResponseToBlock(snapshot, response) : snapshot
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

function isMatchingRequestUserInputBlock(
  block: ProcessingBlock,
  responseKey: string | null
): block is RequestUserInputBlock {
  if (!isPendingRequestUserInputBlock(block)) return false
  if (!responseKey) return true
  const payloadKey = requestUserInputPayloadKey(block.renderPayload)
  return payloadKey === responseKey
}
