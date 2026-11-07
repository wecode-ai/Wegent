import { createContext, useContext, useEffect, useRef } from 'react'
import type { RequestUserInputPayload } from '@wegent/chat-core/runtime'
import {
  hasRequestUserInputResponse,
  isImplementationPlanRequestUserInput,
  isPendingRequestUserInputBlock,
  isRequestUserInputBlock,
  resolveAsyncRequestUserInputAnswers,
  requestUserInputPayloadKey,
} from '@wegent/chat-core/runtime-user-input'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  pendingRequestUserInputPayload,
  requestUserInputQuestionTarget,
} from '@/components/layout/requestUserInputOverlay'
import type { WorkbenchMessage } from '@/types/workbench'
import { canQuickReply } from './runtimeInteractions'

export function canDiscussQuestion(payload: RequestUserInputPayload): boolean {
  return Boolean(
    requestUserInputPayloadKey(payload) &&
    payload.questions?.length &&
    payload.questions.every(question => canQuickReply({ ...payload, questions: [question] })) &&
    (!payload.interactionStatus || payload.interactionStatus === 'pending') &&
    !hasRequestUserInputResponse(payload) &&
    (!payload.expiresAtUnixMs || payload.expiresAtUnixMs > Date.now())
  )
}

/** Fixed implementation confirmation remains a native choice, not a free-form answer. */
export function questionDiscussionAnswerQuestions(payload: RequestUserInputPayload) {
  const questions = payload.questions ?? []
  return isImplementationPlanRequestUserInput(payload)
    ? questions.filter(
        question => question.is_other ?? question.isOther ?? !question.options?.length
      )
    : questions
}

export function questionDiscussionKey(
  source: RuntimeTaskAddress,
  payload: RequestUserInputPayload
) {
  const owners = [
    ...new Set(
      (payload.questions ?? []).map(question =>
        requestUserInputPayloadKey(requestUserInputQuestionTarget(payload, question.id!).payload)
      )
    ),
  ].sort()
  return JSON.stringify([
    source.deviceId,
    source.taskId,
    owners.length > 1 ? { requests: owners } : requestUserInputPayloadKey(payload),
  ])
}

export function pendingDiscussionQuestion(
  messages: WorkbenchMessage[],
  payload: RequestUserInputPayload
): RequestUserInputPayload | null {
  const key = requestUserInputPayloadKey(payload)
  const resolved = resolveAsyncRequestUserInputAnswers(messages)
  if (payload.itemId?.startsWith('implementation-plan:')) {
    const plan = pendingRequestUserInputPayload(resolved)
    return plan && requestUserInputPayloadKey(plan) === key ? plan : null
  }
  const block = [...resolved]
    .reverse()
    .flatMap(message => [...(message.blocks ?? [])].reverse())
    .find(
      block =>
        isRequestUserInputBlock(block) && requestUserInputPayloadKey(block.renderPayload) === key
    )
  return block && isPendingRequestUserInputBlock(block) ? block.renderPayload : null
}

export interface QuestionDiscussionSession {
  source: RuntimeTaskAddress
  payload: RequestUserInputPayload
  address: RuntimeTaskAddress | null
  answers: Record<string, string>
  input?: string
}

export function questionDiscussionDrafts(
  sessions: Record<string, QuestionDiscussionSession>,
  source: RuntimeTaskAddress,
  payload: RequestUserInputPayload
): Record<string, string> {
  return Object.fromEntries(
    (payload.questions ?? []).flatMap(question => {
      if (!question.id) return []
      const target = requestUserInputQuestionTarget(payload, question.id)
      const answer =
        sessions[questionDiscussionKey(source, target.payload)]?.answers[target.questionId]
      return answer === undefined ? [] : [[question.id, answer]]
    })
  )
}

export interface QuestionDiscussionStore {
  accountKey: string
  sessions: Record<string, QuestionDiscussionSession>
  panelRequest: QuestionDiscussionRequest | null
  requestPanel(request: QuestionDiscussionRequest): void
  consumePanelRequest(request: QuestionDiscussionRequest): void
  update(
    key: string,
    update: (session: QuestionDiscussionSession | undefined) => QuestionDiscussionSession
  ): void
  create(
    key: string,
    start: () => Promise<RuntimeTaskAddress | false>
  ): Promise<RuntimeTaskAddress | false>
}

export const QuestionDiscussionStoreContext = createContext<QuestionDiscussionStore | null>(null)
export type QuestionDiscussionTab = `discussion:${string}`
export function isQuestionDiscussionTab(tab: string): tab is QuestionDiscussionTab {
  return tab.startsWith('discussion:')
}

export interface QuestionDiscussionRequest {
  key: string
  source: RuntimeTaskAddress
}

export const QuestionDiscussionContext = createContext<{
  open(source: RuntimeTaskAddress, payload: RequestUserInputPayload): void
  restoreFocus?(key: string): void
  request?: QuestionDiscussionRequest | null
  consume?(request: QuestionDiscussionRequest): void
} | null>(null)

export function useQuestionDiscussion() {
  return useContext(QuestionDiscussionContext)
}

/** Route discussion commands only to the active pane of their source task. */
export function useQuestionDiscussionWorkspacePanel({
  address,
  active,
  openTab,
}: {
  address: RuntimeTaskAddress | null | undefined
  active: boolean
  openTab(tab: QuestionDiscussionTab): void
}) {
  const discussion = useQuestionDiscussion()
  const request = discussion?.request
  const consume = discussion?.consume
  const handled = useRef<QuestionDiscussionRequest | null>(null)
  useEffect(() => {
    if (
      !active ||
      !request ||
      handled.current === request ||
      request.source.deviceId !== address?.deviceId ||
      request.source.taskId !== address?.taskId
    )
      return
    handled.current = request
    consume?.(request)
    const tab: QuestionDiscussionTab = `discussion:${request.key}`
    openTab(tab)
  }, [request, consume, active, address?.deviceId, address?.taskId, openTab])
}

export function questionDiscussionPrompt(
  payload: RequestUserInputPayload,
  introduction: string
): string {
  return [
    introduction,
    ...(payload.questions ?? []).map(question =>
      [
        question.question ?? question.header,
        ...(question.options ?? []).map(
          option => `- ${option.label}${option.description ? `: ${option.description}` : ''}`
        ),
      ].join('\n')
    ),
  ].join('\n\n')
}
