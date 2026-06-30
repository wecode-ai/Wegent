import { useMemo, useState } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { RequestUserInputResponse } from '@/types/api'

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
  const questions = useMemo(() => normalizeQuestions(payload.questions), [payload.questions])
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>(() =>
    initialAnswers(questions)
  )
  const [submitted, setSubmitted] = useState(false)
  const isDisabled = disabled || submitted

  const handleSubmit = () => {
    const answers = Object.fromEntries(
      questions.map(question => [question.id, { answers: [selectedAnswers[question.id] ?? ''] }])
    )
    setSubmitted(true)
    onSubmit?.({
      requestId: payload.requestId ?? payload.request_id,
      itemId: payload.itemId ?? payload.item_id,
      answers,
    })
  }

  return (
    <div
      data-testid="request-user-input-card"
      className="w-full rounded-2xl border border-border bg-background px-5 py-4 shadow-[0_18px_42px_rgba(15,23,42,0.10)]"
    >
      <div className="flex flex-col gap-4">
        {questions.map(question => (
          <div key={question.id} className="min-w-0">
            {question.header ? (
              <div className="mb-2 text-sm font-semibold text-text-primary">{question.header}</div>
            ) : null}
            <div className="mb-3 text-sm font-semibold text-text-primary">{question.question}</div>
            {question.options.length > 0 ? (
              <div className="flex flex-col gap-2">
                {question.options.map((option, index) => {
                  const isSelected = selectedAnswers[question.id] === option.label
                  return (
                    <button
                      key={`${question.id}-${option.label}-${index}`}
                      type="button"
                      data-testid={`request-user-input-option-${question.id}-${index}`}
                      disabled={isDisabled}
                      onClick={() =>
                        setSelectedAnswers(current => ({
                          ...current,
                          [question.id]: option.label,
                        }))
                      }
                      className={cn(
                        'flex min-h-11 w-full min-w-0 items-start gap-3 rounded-lg px-2 py-1.5 text-left transition-colors',
                        isSelected ? 'bg-surface' : 'hover:bg-surface',
                        isDisabled && 'cursor-not-allowed opacity-60'
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
                          isSelected
                            ? 'border-primary bg-primary text-white'
                            : 'border-border bg-surface text-text-muted'
                        )}
                      >
                        {index + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="text-sm font-medium text-text-primary">
                          {option.label}
                        </span>
                        {option.description ? (
                          <span className="ml-2 text-sm text-text-muted">{option.description}</span>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : null}
            {question.allowCustom ? (
              <input
                data-testid={`request-user-input-custom-${question.id}`}
                value={selectedAnswers[question.id] ?? ''}
                disabled={isDisabled}
                onChange={event =>
                  setSelectedAnswers(current => ({
                    ...current,
                    [question.id]: event.target.value,
                  }))
                }
                className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
                placeholder={t('request_user_input.custom_placeholder')}
              />
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-5 flex items-center justify-end gap-3">
        <button
          type="button"
          data-testid="request-user-input-ignore-button"
          disabled={isDisabled}
          onClick={onIgnore}
          className="inline-flex h-9 min-w-[44px] items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-text-muted hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
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
          onClick={handleSubmit}
          className="inline-flex h-9 min-w-[72px] items-center justify-center gap-1.5 rounded-full bg-[#2563eb] px-4 text-sm font-medium text-white shadow-sm hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t('request_user_input.submit')}
          <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
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
