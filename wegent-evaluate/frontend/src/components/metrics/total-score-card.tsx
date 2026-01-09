'use client'

import { useTranslation } from 'react-i18next'
import { Trophy, TrendingUp, TrendingDown, AlertTriangle, CheckCircle } from 'lucide-react'

interface TotalScoreCardProps {
  totalScore?: number
  retrievalScore?: number
  generationScore?: number
  isFailed?: boolean
  failureReason?: string | null
  size?: 'sm' | 'md' | 'lg'
}

function getScoreColor(score: number | undefined | null): string {
  if (score == null) return 'text-gray-500'
  if (score >= 70) return 'text-green-600'
  if (score >= 50) return 'text-yellow-600'
  return 'text-red-600'
}

function getScoreBgColor(score: number | undefined | null): string {
  if (score == null) return 'bg-gray-100'
  if (score >= 70) return 'bg-green-100'
  if (score >= 50) return 'bg-yellow-100'
  return 'bg-red-100'
}

export function TotalScoreCard({
  totalScore,
  retrievalScore,
  generationScore,
  isFailed = false,
  failureReason,
  size = 'md',
}: TotalScoreCardProps) {
  const { t } = useTranslation()

  const sizeClasses = {
    sm: 'p-3',
    md: 'p-4',
    lg: 'p-6',
  }

  const scoreSizeClasses = {
    sm: 'text-2xl',
    md: 'text-3xl',
    lg: 'text-4xl',
  }

  return (
    <div
      className={`rounded-lg border-2 ${sizeClasses[size]} ${
        isFailed ? 'border-red-300 bg-red-50/50' : 'border-primary/30 bg-primary/5'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Trophy className={`h-5 w-5 ${isFailed ? 'text-red-500' : 'text-primary'}`} />
          <h3 className="font-semibold">{t('metrics.totalScore', 'Total Score')}</h3>
        </div>
        {/* Status badge */}
        {isFailed ? (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-100 text-red-700 text-sm font-medium">
            <AlertTriangle className="h-4 w-4" />
            {t('metrics.failed', 'FAILED')}
          </span>
        ) : totalScore != null ? (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-green-100 text-green-700 text-sm font-medium">
            <CheckCircle className="h-4 w-4" />
            {t('metrics.passed', 'PASSED')}
          </span>
        ) : null}
      </div>

      {/* Main score */}
      <div className="flex items-baseline gap-2 mb-4">
        <span
          className={`font-bold ${scoreSizeClasses[size]} ${
            isFailed ? 'text-gray-400 line-through' : getScoreColor(totalScore)
          }`}
        >
          {totalScore != null ? totalScore.toFixed(1) : '-'}
        </span>
        <span className="text-muted-foreground text-sm">/ 100</span>
      </div>

      {/* Failure reason */}
      {isFailed && failureReason && (
        <div className="mb-4 p-2 rounded bg-red-100 text-red-700 text-sm">
          <span className="font-medium">{t('metrics.failureReason', 'Failure Reason')}: </span>
          {failureReason}
        </div>
      )}

      {/* Sub-scores */}
      <div className="grid grid-cols-2 gap-3">
        {/* Retrieval Score */}
        <div className="rounded bg-secondary/50 p-2">
          <div className="flex items-center gap-1 mb-1">
            <TrendingUp className="h-3 w-3 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              {t('metrics.retrievalScore', 'Retrieval Score')}
            </span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-lg font-semibold">
              {retrievalScore != null ? (retrievalScore * 100).toFixed(1) + '%' : '-'}
            </span>
            <span className="text-xs text-muted-foreground">(45%)</span>
          </div>
        </div>

        {/* Generation Score */}
        <div className="rounded bg-secondary/50 p-2">
          <div className="flex items-center gap-1 mb-1">
            <TrendingDown className="h-3 w-3 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              {t('metrics.generationScore', 'Generation Score')}
            </span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-lg font-semibold">
              {generationScore != null ? (generationScore * 100).toFixed(1) + '%' : '-'}
            </span>
            <span className="text-xs text-muted-foreground">(55%)</span>
          </div>
        </div>
      </div>

      {/* Hard threshold warning */}
      <div className="mt-3 text-xs text-muted-foreground">
        {t(
          'metrics.hardThresholdWarning',
          'Hard Threshold: Samples with Faithfulness or Groundedness < 60% are marked as failed'
        )}
      </div>
    </div>
  )
}
