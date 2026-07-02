import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { ChevronDown, CornerDownLeft, MessageCircleQuestion, Pencil } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { RequestUserInputResponse } from '@/types/api'
import { hasImplementationPlanText } from './requestUserInputMessages'

interface RequestUserInputOption {
  label?: string
  description?: string
}

interface RequestUserInputQuestion {
  id?: string
  header?: string
  question?: string
  is_other?: boolean
  isOther?: boolean
  options?: RequestUserInputOption[]
}

export interface RequestUserInputPayload {
  kind?: string
  request_id?: number | string
  requestId?: number | string
  item_id?: string
  itemId?: string
  questions?: RequestUserInputQuestion[]
  response?: RequestUserInputResponse
  requestUserInputResponse?: RequestUserInputResponse
  request_user_input_response?: RequestUserInputResponse
}

interface RequestUserInputCardProps {
  payload: RequestUserInputPayload
  disabled?: boolean
  onSubmit?: (response: RequestUserInputResponse) => void
  onIgnore?: () => void
}

export function RequestUserInputCard({
  payload,
  disabled = false,
  onSubmit,
  onIgnore,
}: RequestUserInputCardProps) {
  const { t } = useTranslation('chat')
  const formRef = useRef<HTMLFormElement | null>(null)
  const questions = useMemo(() => normalizeQuestions(payload.questions), [payload.questions])
  const isImplementationPlanRequest = isImplementationPlanQuestions(questions)
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>(() =>
    initialAnswers(questions)
  )
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(() =>
    initialActiveQuestionId(questions)
  )
  const [submitted, setSubmitted] = useState(false)
  const isDisabled = disabled || submitted
  const customQuestionIds = new Set(
    questions
      .filter(question => question.allowCustom && question.options.length === 0)
      .map(question => question.id)
  )
  const hasCustomQuestion = customQuestionIds.size > 0

  useEffect(() => {
    formRef.current?.focus({ preventScroll: true })
  }, [])

  const handleSubmit = (
    answersOverride?: Record<string, string>,
    activeQuestionIdOverride?: string | null
  ) => {
    if (isDisabled || questions.length === 0) return

    const effectiveAnswers = answersOverride ?? selectedAnswers
    const answers = responseAnswers(
      questions,
      effectiveAnswers,
      activeQuestionIdOverride ?? activeQuestionId
    )
    setSubmitted(true)
    onSubmit?.({
      requestId: payload.requestId ?? payload.request_id,
      itemId: payload.itemId ?? payload.item_id,
      answers,
    })
  }

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    handleSubmit()
  }

  const selectOption = (
    question: ReturnType<typeof normalizeQuestions>[number],
    option: RequestUserInputOption
  ) => {
    const nextAnswers = {
      ...selectedAnswers,
      [question.id]: option.label ?? '',
      ...emptyCustomAnswersForImplementationPlan(questions),
    }
    setActiveQuestionId(question.id)
    setSelectedAnswers(nextAnswers)
    if (shouldSubmitOnOptionSelect(question, option, questions)) {
      handleSubmit(nextAnswers, question.id)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (isDisabled) return

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onIgnore?.()
      return
    }

    if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
      return
    }

    const target = event.target as HTMLElement | null
    if (target?.tagName === 'BUTTON') return

    event.preventDefault()
    event.stopPropagation()
    handleSubmit()
  }

  const actionControls = (
    <>
      <button
        type="button"
        data-testid="request-user-input-ignore-button"
        disabled={isDisabled}
        onClick={onIgnore}
        className="inline-flex h-9 min-w-[44px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-text-muted hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        {t('request_user_input.ignore')}
        <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] font-semibold text-text-secondary">
          ESC
        </kbd>
      </button>
      <button
        type="button"
        data-testid="request-user-input-submit-button"
        disabled={isDisabled || questions.length === 0}
        onClick={() => handleSubmit()}
        className="inline-flex h-9 min-w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-[#2f9bff] px-4 text-sm font-semibold text-white shadow-sm hover:bg-[#1d8af0] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {t('request_user_input.submit')}
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/15">
          <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </button>
    </>
  )

  return (
    <form
      ref={formRef}
      data-testid="request-user-input-card"
      onSubmit={handleFormSubmit}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      className="w-full rounded-[1.5rem] border border-border bg-background px-4 py-2.5 shadow-[0_18px_42px_rgba(15,23,42,0.10)]"
    >
      <div className="flex flex-col gap-1.5">
        {questions.map(question => (
          <div key={question.id} className="min-w-0">
            {question.header ? (
              <div className="mb-1 text-[13px] font-semibold leading-5 text-text-primary">
                {question.header}
              </div>
            ) : null}
            {!customQuestionIds.has(question.id) ? (
              <div className="mb-1.5 text-[13px] font-semibold leading-5 text-text-primary">
                {question.question}
              </div>
            ) : null}
            {question.options.length > 0 ? (
              <div className="flex flex-col gap-1">
                {question.options.map((option, index) => {
                  const isSelected =
                    selectedAnswers[question.id] === option.label &&
                    (!isImplementationPlanRequest || activeQuestionId === question.id)
                  return (
                    <button
                      key={`${question.id}-${option.label}-${index}`}
                      type="button"
                      data-testid={`request-user-input-option-${question.id}-${index}`}
                      disabled={isDisabled}
                      onClick={() => selectOption(question, option)}
                      className={cn(
                        'flex h-9 w-full min-w-0 items-center gap-2.5 rounded-2xl px-3 text-left transition-colors',
                        isSelected ? 'bg-surface' : 'hover:bg-surface',
                        isDisabled && 'cursor-not-allowed opacity-60'
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold leading-none',
                          isSelected
                            ? 'bg-text-primary text-background'
                            : 'bg-surface text-text-muted'
                        )}
                      >
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        <span className="text-[13px] font-semibold leading-5 text-text-primary">
                          {option.label}
                        </span>
                        {option.description ? (
                          <span className="ml-2 text-[13px] leading-5 text-text-muted">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : null}
            {question.allowCustom ? (
              <div className="mt-1 flex min-w-0 items-center gap-2.5 px-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-text-muted">
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <input
                  data-testid={`request-user-input-custom-${question.id}`}
                  value={selectedAnswers[question.id] ?? ''}
                  disabled={isDisabled}
                  onChange={event => {
                    setActiveQuestionId(question.id)
                    setSelectedAnswers(current => ({
                      ...current,
                      [question.id]: event.target.value,
                    }))
                  }}
                  className="h-8 min-w-0 flex-1 rounded-lg border-0 bg-transparent px-0 text-[13px] font-semibold leading-5 text-text-primary outline-none placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder={question.question || t('request_user_input.custom_placeholder')}
                />
                {customQuestionIds.has(question.id) ? (
                  <div className="ml-auto flex shrink-0 items-center gap-2">{actionControls}</div>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {!hasCustomQuestion ? (
        <div className="mt-2 flex items-center justify-end gap-2">{actionControls}</div>
      ) : null}
    </form>
  )
}

export function RequestUserInputSummary({ payload }: { payload: RequestUserInputPayload }) {
  const { t } = useTranslation('chat')
  const questions = useMemo(() => normalizeQuestions(payload.questions), [payload.questions])
  const response =
    payload.response ?? payload.requestUserInputResponse ?? payload.request_user_input_response
  const rows = questions.map(question => ({
    id: question.id,
    question: question.question,
    answer: responseAnswerText(response, question.id),
  }))

  if (rows.length === 0) return null

  return (
    <div
      data-testid="request-user-input-summary"
      className="min-w-0 overflow-x-hidden text-[13px] leading-6 text-text-secondary"
    >
      <div className="mb-1.5 inline-flex max-w-full items-center gap-1.5 text-text-muted">
        <MessageCircleQuestion className="h-4 w-4 shrink-0" strokeWidth={1.7} aria-hidden="true" />
        <span>{t('request_user_input.asked_count', { count: rows.length })}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
      </div>
      <div className="ml-5 flex min-w-0 flex-col gap-1.5">
        {rows.map(row => (
          <div key={row.id} className="min-w-0">
            <div className="font-medium text-text-secondary">{row.question}</div>
            {row.answer ? (
              <div className="mt-0.5 whitespace-pre-wrap text-text-muted">{row.answer}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function normalizeQuestions(questions: RequestUserInputQuestion[] | undefined) {
  return (questions ?? []).map((question, index) => {
    const id = question.id?.trim() || `question_${index + 1}`
    const options = (question.options ?? [])
      .map(option => ({
        label: option.label?.trim() ?? '',
        description: option.description?.trim() ?? '',
      }))
      .filter(option => option.label)
    return {
      id,
      header: question.header?.trim() ?? '',
      question: question.question?.trim() || id,
      options,
      allowCustom: Boolean(question.is_other ?? question.isOther ?? options.length === 0),
    }
  })
}

function initialAnswers(questions: ReturnType<typeof normalizeQuestions>): Record<string, string> {
  return Object.fromEntries(
    questions.map(question => [question.id, question.options[0]?.label ?? ''])
  )
}

function initialActiveQuestionId(questions: ReturnType<typeof normalizeQuestions>): string | null {
  return implementationPlanOptionQuestion(questions)?.id ?? questions[0]?.id ?? null
}

function responseAnswers(
  questions: ReturnType<typeof normalizeQuestions>,
  selectedAnswers: Record<string, string>,
  activeQuestionId: string | null
): RequestUserInputResponse['answers'] {
  if (!isImplementationPlanQuestions(questions)) {
    return Object.fromEntries(
      questions.map(question => [question.id, { answers: [selectedAnswers[question.id] ?? ''] }])
    )
  }

  const activeQuestion = questions.find(question => question.id === activeQuestionId)
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
      answers: [selectedAnswers[implementQuestion.id] ?? implementQuestion.options[0]?.label ?? ''],
    },
  }
}

function emptyCustomAnswersForImplementationPlan(
  questions: ReturnType<typeof normalizeQuestions>
): Record<string, string> {
  if (!isImplementationPlanQuestions(questions)) return {}

  return Object.fromEntries(
    questions
      .filter(question => question.allowCustom && question.options.length === 0)
      .map(question => [question.id, ''])
  )
}

function shouldSubmitOnOptionSelect(
  question: ReturnType<typeof normalizeQuestions>[number],
  option: RequestUserInputOption,
  questions: ReturnType<typeof normalizeQuestions>
): boolean {
  if (questions.length === 1) return true
  if (question.id === 'implement') return true
  return hasImplementationPlanText(option.label)
}

function isImplementationPlanQuestions(questions: ReturnType<typeof normalizeQuestions>): boolean {
  return Boolean(implementationPlanOptionQuestion(questions))
}

function implementationPlanOptionQuestion(
  questions: ReturnType<typeof normalizeQuestions>
): ReturnType<typeof normalizeQuestions>[number] | undefined {
  return questions.find(question => {
    if (question.id.trim().toLowerCase() === 'implement') return true
    if (hasImplementationPlanText(question.question)) return true
    return question.options.some(option => hasImplementationPlanText(option.label))
  })
}

function responseAnswerText(
  response: RequestUserInputResponse | undefined,
  questionId: string
): string {
  return (
    response?.answers?.[questionId]?.answers
      ?.map(answer => answer.trim())
      .filter(Boolean)
      .join('\n') ?? ''
  )
}
