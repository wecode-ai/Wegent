'use client'

import { MetricMeta } from '@/types'
import { useTranslation } from 'react-i18next'

interface MetricCardProps {
  metric: MetricMeta
  score?: number
  size?: 'sm' | 'md' | 'lg'
  showDescription?: boolean
  showThresholdWarning?: boolean
  threshold?: number
}

function getScoreColor(score: number | undefined | null): string {
  if (score == null) return 'bg-gray-100 text-gray-500'
  if (score >= 0.7) return 'bg-green-100 text-green-700'
  if (score >= 0.5) return 'bg-yellow-100 text-yellow-700'
  return 'bg-red-100 text-red-700'
}

function getProgressColor(score: number | undefined | null): string {
  if (score == null) return 'bg-gray-300'
  if (score >= 0.7) return 'bg-green-500'
  if (score >= 0.5) return 'bg-yellow-500'
  return 'bg-red-500'
}

function getFrameworkBadgeClass(framework: string): string {
  if (framework === 'ragas') {
    return 'bg-green-100 text-green-700 border-green-300'
  }
  return 'bg-blue-100 text-blue-700 border-blue-300'
}

export function MetricCard({
  metric,
  score,
  size = 'md',
  showDescription = false,
  showThresholdWarning = false,
  threshold = 0.6,
}: MetricCardProps) {
  const { i18n } = useTranslation()
  const isZh = i18n.language?.startsWith('zh')

  const sizeClasses = {
    sm: 'p-2',
    md: 'p-3',
    lg: 'p-4',
  }

  const scoreSizeClasses = {
    sm: 'text-lg',
    md: 'text-xl',
    lg: 'text-2xl',
  }

  const isBelowThreshold = showThresholdWarning && score != null && score < threshold

  return (
    <div
      className={`rounded-lg border bg-card ${sizeClasses[size]} ${
        isBelowThreshold ? 'border-red-300 bg-red-50/50' : ''
      }`}
    >
      {/* Header with framework badge */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <span
            className={`inline-block px-1.5 py-0.5 text-xs font-medium rounded border ${getFrameworkBadgeClass(
              metric.framework
            )}`}
          >
            {metric.framework.toUpperCase()}
          </span>
        </div>
        <span className="text-xs text-muted-foreground px-1.5 py-0.5 bg-secondary/50 rounded">
          {metric.signalSource.toUpperCase()}
        </span>
      </div>

      {/* Metric name */}
      <p className="text-sm font-medium text-text-primary mb-1 truncate" title={metric.name}>
        {metric.name}
      </p>

      {/* Score */}
      <div className="flex items-center gap-2">
        <span className={`font-semibold ${scoreSizeClasses[size]}`}>
          {score != null ? (score * 100).toFixed(1) + '%' : '-'}
        </span>
        {isBelowThreshold && (
          <span className="text-xs text-red-600 font-medium">
            ⚠️ {'<'} {(threshold * 100).toFixed(0)}%
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="mt-2 h-1.5 w-full bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${getProgressColor(score)}`}
          style={{ width: `${(score ?? 0) * 100}%` }}
        />
      </div>

      {/* Description */}
      {showDescription && (
        <p className="mt-2 text-xs text-muted-foreground">
          {isZh ? metric.descriptionZh : metric.description}
        </p>
      )}
    </div>
  )
}
