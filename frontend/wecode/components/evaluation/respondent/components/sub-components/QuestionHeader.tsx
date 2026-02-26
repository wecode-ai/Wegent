'use client'

import { ChevronLeft, ChevronRight, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'

interface QuestionHeaderProps {
  topicName: string
  progress: number
  formattedTime: string
  currentIndex: number
  totalQuestions: number
  onPrevious: () => void
  onNext: () => void
  isFirst: boolean
  isLast: boolean
}

export function QuestionHeader({
  topicName,
  progress,
  formattedTime,
  currentIndex,
  totalQuestions,
  onPrevious,
  onNext,
  isFirst,
  isLast,
}: QuestionHeaderProps) {
  const { t } = useTranslation('evaluation')
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <>
        {/* Mobile: Top row - Topic, Progress, Timer */}
        <div className="flex h-14 items-center justify-between border-b border-border bg-surface px-4">
          <span className="text-sm font-medium text-text-primary truncate max-w-[120px]">
            {topicName}
          </span>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="text-xs text-text-muted">{t('ui.progress')}</span>
              <div className="h-2 w-16 overflow-hidden rounded-full bg-border">
                <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
              </div>
            </div>
            <div className="flex items-center gap-1 text-sm text-text-secondary">
              <Clock className="h-4 w-4" />
              <span className="text-xs text-text-muted">{t('ui.time_spent')}</span>
              <span className="tabular-nums">{formattedTime}</span>
            </div>
          </div>
        </div>

        {/* Mobile: Bottom row - Navigation */}
        <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
          <Button variant="ghost" size="sm" onClick={onPrevious} disabled={isFirst} className="h-9">
            <ChevronLeft className="mr-1 h-4 w-4" />
            {t('actions.previous')}
          </Button>
          <span className="text-sm text-text-secondary">
            {currentIndex + 1} / {totalQuestions}
          </span>
          <Button variant="ghost" size="sm" onClick={onNext} disabled={isLast} className="h-9">
            {t('actions.next')}
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      </>
    )
  }

  // Desktop: Single row layout
  return (
    <header className="h-16 border-b border-border bg-white px-6 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-4">
        <h1 className="font-semibold text-text-primary truncate max-w-[300px]">{topicName}</h1>
        <Badge variant="secondary" className="text-xs">
          {currentIndex + 1} / {totalQuestions}
        </Badge>
      </div>

      <div className="flex items-center gap-6">
        {/* Progress Bar */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">{t('ui.progress')}</span>
          <div className="flex items-center gap-2">
            <div className="w-24 h-2 bg-border rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-xs text-text-secondary w-8">{progress}%</span>
          </div>
        </div>

        {/* Timer */}
        <div className="flex items-center gap-2 text-text-secondary bg-surface px-3 py-1.5 rounded-lg">
          <Clock className="h-4 w-4" />
          <span className="text-xs text-text-muted">{t('ui.time_spent')}</span>
          <span className="text-sm font-medium tabular-nums">{formattedTime}</span>
        </div>

        {/* Navigation */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onPrevious}
            disabled={isFirst}
            className="h-9 px-4"
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            {t('actions.previous')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onNext}
            disabled={isLast}
            className="h-9 px-4"
          >
            {t('actions.next')}
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      </div>
    </header>
  )
}
