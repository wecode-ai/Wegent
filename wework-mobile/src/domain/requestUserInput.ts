import {
  applyRequestUserInputResponseToBlock,
  hasImplementationPlanText,
  isAsyncRequestUserInputPayload,
  isPendingRequestUserInputBlock,
  isRequestUserInputBlock,
  preserveRequestUserInputResponse,
  requestUserInputPayloadKey,
  resolveAsyncRequestUserInputAnswers,
} from '../../../packages/chat-core/src/runtime-user-input'
import type { WorkbenchMessage } from '../../../packages/chat-core/src/workbench-message-reducer'
import type {
  ChatMessage,
  ChatToolBlock,
  RequestUserInputPayload,
  RequestUserInputResponse,
} from '@/types/runtime'

export {
  isAsyncRequestUserInputPayload,
  isPendingRequestUserInputBlock,
  isRequestUserInputBlock,
  requestUserInputPayloadKey,
}

export function resolveMobileUserInput(messages: ChatMessage[]): ChatMessage[] {
  const projected: WorkbenchMessage[] = messages.map(message => ({
    ...message,
    createdAt: String(message.createdAt),
    status: message.pendingDelivery
      ? 'pending'
      : message.status === 'completed'
        ? 'done'
        : message.status,
    blocks: message.blocks?.filter((block): block is ChatToolBlock => block.type === 'tool'),
  }))
  const resolved = resolveAsyncRequestUserInputAnswers(projected)
  return messages.map((message, index) => {
    const toolBlocks = resolved[index]?.blocks
    if (toolBlocks === projected[index]?.blocks) return message
    return {
      ...message,
      blocks: message.blocks?.map(block => {
        const updated = toolBlocks?.find(candidate => candidate.id === block.id)
        return block.type === 'tool' && updated?.type === 'tool' ? updated : block
      }),
    }
  })
}

export function pendingMobileUserInput(
  messages: ChatMessage[]
): Map<string, RequestUserInputPayload> {
  const pending = new Map<string, RequestUserInputPayload>()
  for (const message of [...messages].reverse()) {
    if (
      message.role === 'user' &&
      message.status === 'completed' &&
      !message.pendingDelivery &&
      message.content.trim()
    )
      break
    for (const block of [...(message.blocks ?? [])].reverse()) {
      if (block.type !== 'tool' || !isPendingRequestUserInputBlock(block)) continue
      const key = requestUserInputPayloadKey(block.renderPayload)
      if (!key) continue
      if (!isAsyncRequestUserInputPayload(block.renderPayload)) {
        return new Map([[key, block.renderPayload]])
      }
      pending.set(key, block.renderPayload)
    }
  }
  return pending
}

export function applyMobileUserInputResponse(
  messages: ChatMessage[],
  response: RequestUserInputResponse
): ChatMessage[] {
  return messages.map(message => ({
    ...message,
    blocks: message.blocks?.map(block => {
      if (block.type !== 'tool') return block
      return applyRequestUserInputResponseToBlock(block, response) as ChatToolBlock
    }),
  }))
}

export function settleMobileUserInput(messages: ChatMessage[], key: string): ChatMessage[] {
  return messages.map(message => ({
    ...message,
    blocks: message.blocks?.map(block => {
      if (
        block.type !== 'tool' ||
        !isPendingRequestUserInputBlock(block) ||
        requestUserInputPayloadKey(block.renderPayload) !== key
      )
        return block
      return {
        ...block,
        status: 'done',
        renderPayload: { ...block.renderPayload, interactionStatus: 'cancelled' },
      }
    }),
  }))
}

export function preserveMobileUserInput(
  previous: ChatMessage[],
  snapshot: ChatMessage[]
): ChatMessage[] {
  const previousBlocks = new Map(
    previous
      .flatMap(message => message.blocks ?? [])
      .filter((block): block is ChatToolBlock => block.type === 'tool')
      .map(block => [block.id, block])
  )
  return snapshot.map(message => ({
    ...message,
    blocks: message.blocks?.map(block => {
      if (block.type !== 'tool') return block
      const local = previousBlocks.get(block.id)
      if (!local || !isRequestUserInputBlock(local) || !isRequestUserInputBlock(block)) return block
      if (
        requestUserInputPayloadKey(local.renderPayload) !==
        requestUserInputPayloadKey(block.renderPayload)
      )
        return block
      if (
        local.renderPayload.interactionStatus === 'cancelled' &&
        isPendingRequestUserInputBlock(block)
      )
        return local
      return preserveRequestUserInputResponse(local, block) as ChatToolBlock
    }),
  }))
}

export function userInputQuestions(payload: RequestUserInputPayload) {
  return (payload.questions ?? []).map((question, index) => {
    const options = (question.options ?? [])
      .map(option => ({
        label: option.label?.trim() ?? '',
        value: option.value?.trim() || option.label?.trim() || '',
        description: option.description?.trim() ?? '',
      }))
      .filter(option => option.label)
    return {
      id: question.id?.trim() || `question_${index + 1}`,
      header: question.header?.trim() ?? '',
      question: question.question?.trim() || question.id || `问题 ${index + 1}`,
      options,
      allowCustom: Boolean(question.is_other ?? question.isOther ?? options.length === 0),
    }
  })
}

export function userInputResponse(
  payload: RequestUserInputPayload,
  answers: Record<string, string>,
  activeQuestionId?: string | null
): RequestUserInputResponse {
  const questions = userInputQuestions(payload)
  const implementation = implementationPlanQuestion(questions)
  const active = questions.find(question => question.id === activeQuestionId)
  const responseQuestions = implementation
    ? [active?.allowCustom ? active : implementation]
    : questions
  return {
    requestId: payload.requestId ?? payload.request_id,
    itemId: payload.itemId ?? payload.item_id,
    ...(payload.interactionScope ? { interactionScope: payload.interactionScope } : {}),
    answers: Object.fromEntries(
      responseQuestions.map(question => [
        question.id,
        {
          answers: [
            answers[question.id] ?? (implementation ? question.options[0]?.value : '') ?? '',
          ],
        },
      ])
    ),
  }
}

export function implementationPlanQuestion(questions: ReturnType<typeof userInputQuestions>) {
  return questions.find(
    question =>
      question.id.toLowerCase() === 'implement' ||
      hasImplementationPlanText(question.question) ||
      question.options.some(option => hasImplementationPlanText(option.label))
  )
}
