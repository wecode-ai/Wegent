import { useCallback, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import { Button as ControlButton } from '../markdown/Button'
import {
  ChevronDown,
  CornerDownLeft,
  MessageCircleQuestion,
  Pencil,
} from 'lucide-react'
import { useConversationTranslation } from './ConversationTranslation'
import { isImeEnterEvent } from '@wegent/chat-core/ime'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import type {
  RequestUserInputResponse,
  RequestUserInputPayload,
  RequestUserInputQuestion,
  RequestUserInputOption,
  Attachment,
} from '@wegent/chat-core/runtime'
import {
  RequestUserInputAnswerEditor,
  type RequestUserInputComposerServices,
} from './RequestUserInputAnswerEditor'
export type { RequestUserInputPayload } from '@wegent/chat-core/runtime'
import {
  hasImplementationPlanText,
  hasRequestUserInputResponse,
  isAsyncRequestUserInputPayload,
  requestUserInputApprovalDescription,
} from '@wegent/chat-core/runtime-user-input'
import { McpUrlAuthorizationCard } from './McpUrlAuthorizationCard'
import {
  requestUserInputExpired,
  useRequestUserInputDeadline,
} from './useRequestUserInputDeadline'
import {
  implementationPlanOptionQuestion,
  initialActiveQuestionId,
  initialAnswers,
  normalizeQuestions,
  sameAttachmentDrafts,
  sameOptionDrafts,
} from './requestUserInputQuestions'

export interface RequestUserInputCardProps {
  payload: RequestUserInputPayload
  compact?: boolean
  disabled?: boolean
  error?: string
  draftAnswers?: Record<string, string>
  onDraftAnswersChange?: (answers: Record<string, string>) => void
  draftOptionAnswers?: Record<string, string>
  onDraftOptionAnswersChange?: (answers: Record<string, string>) => void
  draftAttachments?: Record<string, Attachment[]>
  onDraftAttachmentsChange?: (attachments: Record<string, Attachment[]>) => void
  onDraftAttachmentDelta?: (change: {
    questionId: string
    previous: Attachment[]
    next: Attachment[]
  }) => void
  composerServices?: RequestUserInputComposerServices
  allowSkip?: boolean
  onSubmit?: (
    response: RequestUserInputResponse,
  ) => boolean | void | Promise<boolean | void>
  onSkip?: () => boolean | void | Promise<boolean | void>
  onIgnore?: () => void
  onCollapse?: () => void
  additionalActions?: ReactNode
  onOpenAuthorizationUrl?: (url: string) => void | boolean | Promise<unknown>
}

export function RequestUserInputCard(props: RequestUserInputCardProps) {
  const { expired, remainingTime } = useRequestUserInputDeadline(props.payload)
  if (
    expired ||
    hasRequestUserInputResponse(props.payload) ||
    (props.payload.interactionStatus &&
      props.payload.interactionStatus !== 'pending')
  ) {
    return (
      <RequestUserInputSummary
        payload={
          expired
            ? { ...props.payload, interactionStatus: 'expired' }
            : props.payload
        }
      />
    )
  }
  if (props.payload.interactionKind === 'mcp_url') {
    return <McpUrlAuthorizationCard {...props} remainingTime={remainingTime} />
  }
  return <RequestUserInputForm {...props} remainingTime={remainingTime} />
}

function RequestUserInputForm({
  payload,
  compact = false,
  disabled = false,
  onSubmit,
  onSkip,
  onIgnore,
  onCollapse,
  additionalActions,
  error,
  draftAnswers,
  onDraftAnswersChange,
  draftOptionAnswers,
  onDraftOptionAnswersChange,
  remainingTime,
  draftAttachments,
  onDraftAttachmentsChange,
  onDraftAttachmentDelta,
  composerServices,
  allowSkip = false,
}: RequestUserInputCardProps & { remainingTime: string | null }) {
  const { t } = useConversationTranslation()
  const formId = useId()
  const focusForm = useCallback((node: HTMLFormElement | null) => {
    node?.focus({ preventScroll: true })
  }, [])
  const submitInFlightRef = useRef(false)
  const questions = useMemo(
    () => normalizeQuestions(localizeApprovalQuestions(payload, t)),
    [payload, t],
  )
  const isCommandApproval =
    (payload.interactionKind ?? payload.interaction_kind) === 'approval' &&
    (payload.approvalKind ?? payload.approval_kind ?? 'command') === 'command'
  const isImplementationPlanRequest = isImplementationPlanQuestions(questions)
  const optionOnly =
    compact &&
    questions.length === 1 &&
    questions[0].options.length > 0 &&
    !questions[0].allowCustom
  const [localAnswers, setLocalAnswers] = useState<Record<string, string>>(
    () => ({
      ...initialAnswers(questions),
      ...draftOptionAnswers,
    }),
  )
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({})
  const [customModes, setCustomModes] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      questions.flatMap<[string, boolean]>((question) => {
        if (question.id in (draftOptionAnswers ?? {}))
          return [[question.id, false]]
        return question.allowCustom && draftAttachments?.[question.id]?.length
          ? [[question.id, true]]
          : []
      }),
    ),
  )
  const [answerAttachments, setAnswerAttachments] = useState(
    draftAttachments ?? {},
  )
  const answerAttachmentsRef = useRef(answerAttachments)
  const draftOptionsRef = useRef(draftOptionAnswers ?? {})
  const [previousOptionDrafts, setPreviousOptionDrafts] =
    useState(draftOptionAnswers)
  const [processedAttachmentDrafts, setProcessedAttachmentDrafts] = useState<
    Record<string, Attachment[] | undefined>
  >(() => draftAttachments ?? {})
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(
    () =>
      Object.keys(draftOptionAnswers ?? {})[0] ??
      initialActiveQuestionId(questions, draftAnswers, draftAttachments),
  )
  const selectCustomQuestion = useCallback(
    (id: string) => {
      setActiveQuestionId(id)
      setCustomModes((current) => ({ ...current, [id]: true }))
      if (id in draftOptionsRef.current || isImplementationPlanRequest) {
        const next = isImplementationPlanRequest
          ? {}
          : { ...draftOptionsRef.current }
        delete next[id]
        draftOptionsRef.current = next
        onDraftOptionAnswersChange?.(next)
      }
    },
    [isImplementationPlanRequest, onDraftOptionAnswersChange],
  )
  const [inputReadiness, setInputReadiness] = useState<Record<string, boolean>>(
    {},
  )
  const ready = questions.every(
    (question) =>
      !question.allowCustom ||
      (inputReadiness[question.id] !== false &&
        (answerAttachments[question.id] ?? []).every(
          (attachment) => attachment.status === 'ready',
        )),
  )
  const [previousDrafts, setPreviousDrafts] = useState(draftAnswers)
  if (!sameOptionDrafts(previousOptionDrafts, draftOptionAnswers)) {
    setPreviousOptionDrafts(draftOptionAnswers)
    const nextOptions = draftOptionAnswers ?? {}
    const changedIds = new Set([
      ...Object.keys(draftOptionsRef.current),
      ...Object.keys(nextOptions),
    ])
    for (const id of changedIds) {
      if (draftOptionsRef.current[id] === nextOptions[id]) continue
      setLocalAnswers((current) => {
        const next = { ...current }
        if (id in nextOptions) next[id] = nextOptions[id]
        else delete next[id]
        return next
      })
      if (questions.find((question) => question.id === id)?.allowCustom)
        setCustomModes((current) => ({
          ...current,
          [id]: !(id in nextOptions),
        }))
    }
    draftOptionsRef.current = nextOptions
  }
  const nextAttachments = draftAttachments ?? {}
  const attachmentDraftIds = new Set([
    ...Object.keys(processedAttachmentDrafts),
    ...Object.keys(nextAttachments),
  ])
  const settledAttachmentIds = [...attachmentDraftIds].filter(
    (id) =>
      inputReadiness[id] !== false &&
      !sameAttachmentDrafts(processedAttachmentDrafts[id], nextAttachments[id]),
  )
  if (settledAttachmentIds.length) {
    const local = { ...answerAttachmentsRef.current }
    const changedIds = settledAttachmentIds.filter(
      (id) => !sameAttachmentDrafts(local[id], nextAttachments[id]),
    )
    setProcessedAttachmentDrafts((current) => ({
      ...current,
      ...Object.fromEntries(
        settledAttachmentIds.map((id) => [id, nextAttachments[id]]),
      ),
    }))
    for (const id of changedIds) local[id] = nextAttachments[id] ?? []
    if (changedIds.length) {
      answerAttachmentsRef.current = local
      setAnswerAttachments(local)
      setCustomModes((current) => ({
        ...current,
        ...Object.fromEntries(
          changedIds
            .filter((id) => nextAttachments[id]?.length)
            .map((id) => [id, true]),
        ),
      }))
    }
  }
  if (previousDrafts !== draftAnswers) {
    setPreviousDrafts(draftAnswers)
    const changes = Object.entries(draftAnswers ?? {}).filter(
      ([id, value]) => previousDrafts?.[id] !== value,
    )
    if (changes.length) {
      const customChanges = changes.filter(
        ([id]) => !(id in (draftOptionAnswers ?? {})),
      )
      if (customChanges.length) {
        setCustomAnswers((current) => ({
          ...current,
          ...Object.fromEntries(customChanges),
        }))
        setCustomModes((current) => ({
          ...current,
          ...Object.fromEntries(customChanges.map(([id]) => [id, true])),
        }))
        setActiveQuestionId(customChanges[customChanges.length - 1][0])
      }
    }
  }
  // Newly arriving questions receive their defaults without resetting drafts.
  const selectedAnswers = {
    ...initialAnswers(questions),
    ...localAnswers,
    ...Object.fromEntries(
      questions.flatMap((question) =>
        (customModes[question.id] ?? Boolean(draftAnswers?.[question.id]))
          ? [
              [
                question.id,
                customAnswers[question.id] ?? draftAnswers?.[question.id] ?? '',
              ],
            ]
          : [],
      ),
    ),
  }
  const setSelectedAnswers = (
    update:
      | Record<string, string>
      | ((current: Record<string, string>) => Record<string, string>),
  ) => {
    const next = typeof update === 'function' ? update(selectedAnswers) : update
    setLocalAnswers(next)
  }
  const selectedQuestionId = activeQuestionId
  const [submitted, setSubmitted] = useState(false)
  const questionIds = useMemo(
    () => JSON.stringify(questions.map((question) => question.id)),
    [questions],
  )
  const [skippedQuestionIds, setSkippedQuestionIds] = useState<string | null>(
    null,
  )
  const skipped = skippedQuestionIds === questionIds
  const [submissionError, setSubmissionError] = useState<string | null>(null)
  const isDisabled = disabled || submitted

  const submitAnswers = async (
    answers: RequestUserInputResponse['answers'],
  ): Promise<boolean> => {
    if (
      isDisabled ||
      requestUserInputExpired(payload) ||
      submitInFlightRef.current ||
      !onSubmit
    )
      return false

    submitInFlightRef.current = true
    setSubmissionError(null)
    try {
      const accepted = await onSubmit({
        requestId: payload.requestId ?? payload.request_id,
        itemId: payload.itemId ?? payload.item_id,
        ...(payload.interactionScope
          ? { interactionScope: payload.interactionScope }
          : {}),
        ...(isAsyncRequestUserInputPayload(payload)
          ? { delivery: 'async' as const }
          : {}),
        answers,
      })
      if (accepted !== false) setSubmitted(true)
      return accepted !== false
    } catch (cause) {
      setSubmissionError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      submitInFlightRef.current = false
    }
  }

  const handleSubmit = (
    answersOverride?: Record<string, string>,
    activeQuestionIdOverride?: string | null,
  ): Promise<boolean> => {
    if (questions.length === 0 || !ready) return Promise.resolve(false)
    const answers = responseAnswers(
      questions,
      answersOverride ?? selectedAnswers,
      activeQuestionIdOverride ?? selectedQuestionId,
    )
    for (const [id, answer] of Object.entries(answers)) {
      const attachments = answerAttachments[id]
      if (attachments?.length) answer.attachments = attachments
    }
    return submitAnswers(answers)
  }

  const interactionKind = payload.interactionKind ?? payload.interaction_kind
  const isMcpForm = interactionKind === 'mcp_form'
  const canSkip =
    allowSkip &&
    !['approval', 'mcp_form', 'mcp_url'].includes(interactionKind ?? '') &&
    !isImplementationPlanRequest
  const canIgnore =
    Boolean(onCollapse) || (isMcpForm ? Boolean(onSubmit) : Boolean(onIgnore))
  const handleSkip = async () => {
    if (!isAsyncRequestUserInputPayload(payload)) {
      await submitAnswers(
        Object.fromEntries(
          questions.map((question) => [question.id, { answers: [] }]),
        ),
      )
      return
    }
    if (
      isDisabled ||
      requestUserInputExpired(payload) ||
      submitInFlightRef.current
    )
      return
    submitInFlightRef.current = true
    setSubmissionError(null)
    try {
      if ((await onSkip?.()) !== false) setSkippedQuestionIds(questionIds)
    } catch (cause) {
      setSubmissionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      submitInFlightRef.current = false
    }
  }
  const handleIgnore = () => {
    if (onCollapse) return onCollapse()
    // Cancel this MCP request, not the containing task or its other questions.
    if (isMcpForm) void submitAnswers({})
    else onIgnore?.()
  }

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void handleSubmit()
  }

  const selectOption = (
    question: ReturnType<typeof normalizeQuestions>[number],
    option: RequestUserInputOption,
  ) => {
    const nextAnswers = {
      ...selectedAnswers,
      [question.id]: option.value ?? '',
      ...emptyCustomAnswersForImplementationPlan(questions),
    }
    setActiveQuestionId(question.id)
    setCustomModes((current) => ({ ...current, [question.id]: false }))
    setSelectedAnswers(nextAnswers)
    draftOptionsRef.current = {
      ...draftOptionsRef.current,
      [question.id]: option.value ?? '',
    }
    onDraftOptionAnswersChange?.(draftOptionsRef.current)
    if (shouldSubmitOnOptionSelect(question, option, questions)) {
      void handleSubmit(nextAnswers, question.id)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (isDisabled || event.defaultPrevented) return

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      handleIgnore()
      return
    }

    if (isImeEnterEvent(event)) return

    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return
    }

    const target = event.target as HTMLElement | null
    if (target?.closest('[contenteditable]')) return
    if (target?.tagName === 'BUTTON') return

    event.preventDefault()
    event.stopPropagation()
    void handleSubmit()
  }

  const actionControls = (
    <>
      {additionalActions}
      {canSkip && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="request-user-input-skip-button"
          disabled={
            isDisabled ||
            (!isAsyncRequestUserInputPayload(payload) && !onSubmit)
          }
          onClick={() => void handleSkip()}
          className="inline-flex h-11 min-w-[44px] shrink-0 items-center justify-center rounded-lg px-2 text-sm text-text-secondary hover:bg-muted disabled:opacity-50 md:h-8"
        >
          {t('request_user_input.skip')}
        </ControlButton>
      )}
      {(!compact || canIgnore) && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="request-user-input-ignore-button"
          disabled={isDisabled || !canIgnore}
          onClick={handleIgnore}
          className="inline-flex h-11 min-w-[44px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-text-muted hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60 md:h-8"
        >
          {t(
            onCollapse
              ? 'request_user_input.collapse'
              : 'request_user_input.ignore',
          )}
          <kbd className="rounded border border-border/70 bg-background px-1.5 py-0.5 text-xs font-medium text-text-secondary">
            ESC
          </kbd>
        </ControlButton>
      )}
      <ControlButton
        variant="primary"
        size="sm"
        type="button"
        data-testid="request-user-input-submit-button"
        disabled={isDisabled || !ready || questions.length === 0 || !onSubmit}
        onClick={() => void handleSubmit()}
        className="inline-flex h-11 min-w-[68px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 md:h-8"
      >
        {t('request_user_input.submit')}
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-white/15">
          <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </ControlButton>
    </>
  )

  return (
    <>
      {skipped && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="request-user-input-skipped"
          onClick={() => setSkippedQuestionIds(null)}
          className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted md:min-h-8"
        >
          {t('request_user_input.skipped_reply')}
        </ControlButton>
      )}
      <form
        hidden={skipped}
        inert={skipped}
        ref={focusForm}
        data-testid="request-user-input-card"
        onSubmit={handleFormSubmit}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
        className={cn(
          'mx-auto max-h-[min(60dvh,36rem)] w-full max-w-2xl flex-col px-3 py-3',
          skipped ? 'hidden' : 'flex',
          compact
            ? 'rounded-lg bg-muted/70'
            : 'rounded-2xl border border-border/70 bg-base shadow-sm',
        )}
      >
        {remainingTime && (
          <p
            data-testid="request-user-input-deadline"
            role="timer"
            aria-live="off"
            className="mb-2 text-sm text-text-muted"
          >
            {t('request_user_input.expires_in', { time: remainingTime })}
          </p>
        )}
        {(error || submissionError) && (
          <p role="alert" className="mb-2 text-sm text-error">
            {error || submissionError}
          </p>
        )}
        <div
          data-testid="request-user-input-questions"
          className="scrollbar-soft min-h-0 flex-1 overflow-y-auto pr-1"
        >
          <div className="flex flex-col gap-1.5">
            {questions.map((question, questionIndex) => (
              <div key={question.id} className="min-w-0">
                {question.header ? (
                  <div className="mb-1 text-sm font-medium leading-5 text-text-primary">
                    {question.header}
                  </div>
                ) : null}
                <div
                  id={`${formId}-${questionIndex}`}
                  data-testid={`request-user-input-question-${question.id}`}
                  className="mb-1.5 whitespace-pre-wrap break-words text-sm font-medium leading-5 text-text-primary"
                >
                  {isCommandApproval ? highlightRm(question.question) : question.question}
                </div>
                {question.options.length > 0 ? (
                  <div
                    className={cn(
                      'flex',
                      compact ? 'flex-wrap gap-2' : 'flex-col gap-1',
                    )}
                  >
                    {question.options.map((option, index) => {
                      const isSelected =
                        selectedAnswers[question.id] === option.value &&
                        (!isImplementationPlanRequest ||
                          selectedQuestionId === question.id)
                      return (
                        <ControlButton
                          variant="unstyled"
                          key={`${question.id}-${option.label}-${index}`}
                          type="button"
                          data-testid={`request-user-input-option-${question.id}-${index}`}
                          disabled={isDisabled}
                          onClick={() => selectOption(question, option)}
                          className={cn(
                            'flex min-w-0 items-start gap-2.5 px-2.5 py-1.5 text-left transition-colors',
                            compact
                              ? 'min-h-11 rounded-md border border-border md:min-h-7'
                              : 'min-h-9 w-full rounded-xl',
                            isSelected ? 'bg-muted' : 'hover:bg-muted/70',
                            isDisabled && 'cursor-not-allowed opacity-60',
                          )}
                        >
                          {!compact && (
                            <span
                              className={cn(
                                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold leading-none',
                                isSelected
                                  ? 'bg-text-primary text-background'
                                  : 'bg-muted text-text-muted',
                              )}
                            >
                              {index + 1}
                            </span>
                          )}
                          <span className="min-w-0 flex-1 whitespace-normal break-words">
                            <span className="text-sm font-medium leading-5 text-text-primary">
                              {option.label}
                            </span>
                            {option.description ? (
                              <span className="ml-2 text-sm leading-5 text-text-muted">
                                {option.description}
                              </span>
                            ) : null}
                          </span>
                        </ControlButton>
                      )
                    })}
                  </div>
                ) : null}
                {question.allowCustom ? (
                  <div
                    data-testid={`request-user-input-answer-row-${question.id}`}
                    className="mt-1 flex min-h-11 min-w-0 items-center gap-2.5 rounded-xl bg-muted/60 px-2.5 py-1.5 md:min-h-0"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-text-muted">
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                    <RequestUserInputAnswerEditor
                      questionId={question.id}
                      labelId={`${formId}-${questionIndex}`}
                      value={
                        customAnswers[question.id] ??
                        draftAnswers?.[question.id] ??
                        ''
                      }
                      disabled={isDisabled}
                      services={composerServices}
                      initialAttachments={answerAttachments[question.id]}
                      onChange={(value) => {
                        selectCustomQuestion(question.id)
                        const next = {
                          ...draftAnswers,
                          ...customAnswers,
                          [question.id]: value,
                        }
                        setCustomAnswers(next)
                        onDraftAnswersChange?.(next)
                      }}
                      onSubmit={(value) => {
                        setActiveQuestionId(question.id)
                        void handleSubmit(
                          { ...selectedAnswers, [question.id]: value },
                          question.id,
                        )
                      }}
                      onAttachmentsChange={(attachments) => {
                        const current = answerAttachmentsRef.current
                        if (
                          current[question.id] === attachments ||
                          (!current[question.id] && !attachments.length)
                        )
                          return
                        const next = { ...current, [question.id]: attachments }
                        answerAttachmentsRef.current = next
                        setAnswerAttachments(next)
                        if (attachments.length)
                          selectCustomQuestion(question.id)
                        onDraftAttachmentsChange?.(next)
                        onDraftAttachmentDelta?.({
                          questionId: question.id,
                          previous: current[question.id] ?? [],
                          next: attachments,
                        })
                      }}
                      onReadyChange={(ready) =>
                        setInputReadiness((current) =>
                          current[question.id] === ready
                            ? current
                            : {
                                ...current,
                                [question.id]: ready,
                              },
                        )
                      }
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
        {(!optionOnly || canSkip) && (
          <div className="mt-2 flex shrink-0 flex-wrap items-center justify-end gap-2">
            {actionControls}
          </div>
        )}
      </form>
    </>
  )
}

export function RequestUserInputSummary({
  payload,
}: {
  payload: RequestUserInputPayload
}) {
  const { t } = useConversationTranslation()
  const questions = useMemo(
    () => normalizeQuestions(localizeApprovalQuestions(payload, t)),
    [payload, t],
  )
  const response =
    payload.response ??
    payload.requestUserInputResponse ??
    payload.request_user_input_response
  const rows = questions.map((question) => {
    const answer = responseAnswerText(response, question.id)
    return {
      id: question.id,
      question: question.question,
      answer:
        question.options.find((option) => option.value === answer)?.label ??
        answer,
      filenames:
        response?.answers?.[question.id]?.attachments?.map(
          (file) => file.filename,
        ) ?? [],
    }
  })

  const interactionStatus = requestUserInputExpired(payload)
    ? 'expired'
    : payload.interactionStatus
  if (interactionStatus === 'expired' || interactionStatus === 'cancelled') {
    return (
      <div
        data-testid="request-user-input-summary"
        className="text-sm text-text-secondary"
      >
        <p
          role="status"
          data-testid={`request-user-input-${interactionStatus}`}
        >
          {t(`request_user_input.${interactionStatus}`)}
        </p>
      </div>
    )
  }

  if (payload.interactionKind === 'mcp_url') {
    return (
      <div
        data-testid="request-user-input-summary"
        className="text-sm text-text-secondary"
      >
        {t('request_user_input.url_summary')}
      </div>
    )
  }
  if (rows.length === 0) return null

  return (
    <div
      data-testid="request-user-input-summary"
      className="min-w-0 overflow-x-hidden text-sm leading-6 text-text-secondary"
    >
      <div className="mb-1.5 inline-flex max-w-full items-center gap-1.5 text-text-muted">
        <MessageCircleQuestion
          className="h-4 w-4 shrink-0"
          strokeWidth={1.7}
          aria-hidden="true"
        />
        <span>
          {t('request_user_input.asked_count', { count: rows.length })}
        </span>
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0"
          strokeWidth={2}
          aria-hidden="true"
        />
      </div>
      <div className="ml-5 flex min-w-0 flex-col gap-1.5">
        {rows.map((row) => (
          <div key={row.id} className="min-w-0">
            <div className="font-medium text-text-secondary">
              {row.question}
            </div>
            {row.answer ? (
              <div className="mt-0.5 whitespace-pre-wrap text-text-muted">
                {row.answer}
              </div>
            ) : null}
            {row.filenames.map((filename, index) => (
              <div key={`${filename}-${index}`} className="text-text-muted">
                {filename}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

const CODEX_APPROVAL_QUESTION_ID = '__codex_approval'

function highlightRm(commandText: string) {
  return commandText.split(/(?<![\w.-])(rm)(?![\w./-])/).map((part, index) =>
    index % 2 === 1 ? (
      <strong key={index} className="font-semibold text-destructive">
        {part}
      </strong>
    ) : (
      part
    )
  )
}

function localizeApprovalQuestions(
  payload: RequestUserInputPayload,
  t: ReturnType<typeof useConversationTranslation>['t'],
): RequestUserInputQuestion[] | undefined {
  const interactionKind = payload.interactionKind ?? payload.interaction_kind
  if (interactionKind !== 'approval') return payload.questions

  const { detail, key: questionKey } =
    requestUserInputApprovalDescription(payload)

  return [
    {
      id: CODEX_APPROVAL_QUESTION_ID,
      header: t('request_user_input.approval_title'),
      question: t(questionKey, {
        detail: detail || t('request_user_input.approval_no_detail'),
      }),
      options: (payload.questions?.[0]?.options ?? []).map((option) => {
        const value = option.label?.trim() ?? ''
        const localized = localizeApprovalOption(
          value,
          option.description ?? '',
          t,
        )
        return {
          value,
          label: localized.label,
          description: localized.description,
        }
      }),
    },
  ]
}

function localizeApprovalOption(
  value: string,
  detail: string,
  t: ReturnType<typeof useConversationTranslation>['t'],
): { label: string; description: string } {
  if (value === 'allow_execpolicy' || value.startsWith('allow_execpolicy:')) {
    return {
      label: t('request_user_input.approval_allow_execpolicy'),
      description: t(
        'request_user_input.approval_allow_execpolicy_description',
        { detail },
      ),
    }
  }
  if (value.startsWith('apply_network_policy:')) {
    const separator = detail.indexOf(':')
    const action = separator >= 0 ? detail.slice(0, separator) : 'allow'
    const host = separator >= 0 ? detail.slice(separator + 1) : detail
    const key =
      action === 'deny'
        ? 'request_user_input.approval_deny_network_host'
        : 'request_user_input.approval_allow_network_host'
    return {
      label: t(key, { host }),
      description: t(`${key}_description`, { host }),
    }
  }
  return {
    label: t(`request_user_input.approval_${value}`),
    description: t(`request_user_input.approval_${value}_description`),
  }
}

function responseAnswers(
  questions: ReturnType<typeof normalizeQuestions>,
  selectedAnswers: Record<string, string>,
  activeQuestionId: string | null,
): RequestUserInputResponse['answers'] {
  if (!isImplementationPlanQuestions(questions)) {
    return Object.fromEntries(
      questions.map((question) => [
        question.id,
        { answers: [selectedAnswers[question.id] ?? ''] },
      ]),
    )
  }

  const activeQuestion = questions.find(
    (question) => question.id === activeQuestionId,
  )
  if (activeQuestion?.allowCustom) {
    return {
      [activeQuestion.id]: {
        answers: [selectedAnswers[activeQuestion.id] ?? ''],
      },
    }
  }

  const implementQuestion = implementationPlanOptionQuestion(questions)
  if (!implementQuestion) return {}

  return {
    [implementQuestion.id]: {
      answers: [
        selectedAnswers[implementQuestion.id] ??
          implementQuestion.options[0]?.value ??
          '',
      ],
    },
  }
}

function emptyCustomAnswersForImplementationPlan(
  questions: ReturnType<typeof normalizeQuestions>,
): Record<string, string> {
  if (!isImplementationPlanQuestions(questions)) return {}

  return Object.fromEntries(
    questions
      .filter(
        (question) => question.allowCustom && question.options.length === 0,
      )
      .map((question) => [question.id, '']),
  )
}

function shouldSubmitOnOptionSelect(
  question: ReturnType<typeof normalizeQuestions>[number],
  option: RequestUserInputOption,
  questions: ReturnType<typeof normalizeQuestions>,
): boolean {
  if (questions.length === 1) return true
  if (question.id === 'implement') return true
  return hasImplementationPlanText(option.label)
}

function isImplementationPlanQuestions(
  questions: ReturnType<typeof normalizeQuestions>,
): boolean {
  return Boolean(implementationPlanOptionQuestion(questions))
}

function responseAnswerText(
  response: RequestUserInputResponse | undefined,
  questionId: string,
): string {
  return (
    response?.answers?.[questionId]?.answers
      ?.map((answer) => answer.trim())
      .filter(Boolean)
      .join('\n') ?? ''
  )
}
