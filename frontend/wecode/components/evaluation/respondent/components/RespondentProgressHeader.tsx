'use client'

import { ChevronLeft, ChevronRight, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

interface RespondentProgressHeaderProps {
  topicName: string
  currentQuestion: number
  totalQuestions: number
  formattedTime: string
  onPrevious: () => void
  onNext: () => void
  hasPrevious: boolean
  hasNext: boolean
}

export function RespondentProgressHeader({
  topicName,
  currentQuestion,
  totalQuestions,
  formattedTime,
  onPrevious,
  onNext,
  hasPrevious,
  hasNext,
}: RespondentProgressHeaderProps) {
  const { t } = useTranslation('evaluation')
  const progress = Math.round((currentQuestion / totalQuestions) * 100)

  return (
    <div className="flex h-14 items-center justify-between border-b border-border bg-surface px-4">
      {/* Left: Topic name */}
      <div className="flex items-center gap-3">
        <span className="max-w-[200px] truncate text-sm font-medium text-text-primary">
          {topicName}
        </span>
      </div>

      {/* Center: Progress */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary">{currentQuestion}</span>
          <span className="text-sm text-text-muted">/</span>
          <span className="text-sm text-text-muted">{totalQuestions}</span>
        </div>
        <div
          className="h-2 w-32 overflow-hidden rounded-full bg-border"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Right: Timer + Navigation */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-sm text-text-secondary">
          <Clock className="h-4 w-4" />
          <span className="tabular-nums">{formattedTime}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onPrevious}
            disabled={!hasPrevious}
            aria-label={t('actions.previous')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onNext}
            disabled={!hasNext}
            aria-label={t('actions.next')}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
