'use client'

import { MetricMeta } from '@/types'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle } from 'lucide-react'

interface CrossValidationPairCardProps {
  ragasMetric: MetricMeta
  trulensMetric: MetricMeta
  ragasScore?: number
  trulensScore?: number
  alertThreshold?: number
  label?: string
  showThresholdWarning?: boolean
  hardThreshold?: number
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

export function CrossValidationPairCard({
  ragasMetric,
  trulensMetric,
  ragasScore,
  trulensScore,
  alertThreshold = 0.2,
  label,
  showThresholdWarning = false,
  hardThreshold = 0.6,
}: CrossValidationPairCardProps) {
  const { t, i18n } = useTranslation()
  const isZh = i18n.language?.startsWith('zh')

  // Calculate difference
  const difference =
    ragasScore != null && trulensScore != null
      ? Math.abs(ragasScore - trulensScore)
      : undefined

  const isAlert = difference != null && difference > alertThreshold

  // Check hard threshold
  const ragasBelowThreshold =
    showThresholdWarning && ragasScore != null && ragasScore < hardThreshold
  const trulensBelowThreshold =
    showThresholdWarning && trulensScore != null && trulensScore < hardThreshold

  return (
    <div className={`rounded-lg border bg-card p-4 ${isAlert ? 'border-orange-300' : ''}`}>
      {/* Label header if provided */}
      {label && (
        <div className="mb-3 pb-2 border-b">
          <h4 className="text-sm font-medium text-text-primary">{label}</h4>
        </div>
      )}

      {/* Two metric cards side by side */}
      <div className="grid grid-cols-2 gap-4">
        {/* RAGAS metric */}
        <div
          className={`rounded-lg border p-3 ${
            ragasBelowThreshold ? 'border-red-300 bg-red-50/50' : 'border-green-200 bg-green-50/30'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="inline-block px-1.5 py-0.5 text-xs font-medium rounded border bg-green-100 text-green-700 border-green-300">
              RAGAS
            </span>
            <span className="text-xs text-muted-foreground px-1.5 py-0.5 bg-secondary/50 rounded">
              {ragasMetric.signalSource.toUpperCase()}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mb-1 truncate" title={ragasMetric.name}>
            {ragasMetric.name}
          </p>
          <div className="flex items-center gap-2">
            <span className="text-xl font-semibold">
              {ragasScore != null ? (ragasScore * 100).toFixed(1) + '%' : '-'}
            </span>
            {ragasBelowThreshold && (
              <span className="text-xs text-red-600 font-medium">
                ⚠️ {'<'} {(hardThreshold * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <div className="mt-2 h-1.5 w-full bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${getProgressColor(ragasScore)}`}
              style={{ width: `${(ragasScore ?? 0) * 100}%` }}
            />
          </div>
        </div>

        {/* TruLens metric */}
        <div
          className={`rounded-lg border p-3 ${
            trulensBelowThreshold ? 'border-red-300 bg-red-50/50' : 'border-blue-200 bg-blue-50/30'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="inline-block px-1.5 py-0.5 text-xs font-medium rounded border bg-blue-100 text-blue-700 border-blue-300">
              TruLens
            </span>
            <span className="text-xs text-muted-foreground px-1.5 py-0.5 bg-secondary/50 rounded">
              {trulensMetric.signalSource.toUpperCase()}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mb-1 truncate" title={trulensMetric.name}>
            {trulensMetric.name}
          </p>
          <div className="flex items-center gap-2">
            <span className="text-xl font-semibold">
              {trulensScore != null ? (trulensScore * 100).toFixed(1) + '%' : '-'}
            </span>
            {trulensBelowThreshold && (
              <span className="text-xs text-red-600 font-medium">
                ⚠️ {'<'} {(hardThreshold * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <div className="mt-2 h-1.5 w-full bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${getProgressColor(trulensScore)}`}
              style={{ width: `${(trulensScore ?? 0) * 100}%` }}
            />
          </div>
        </div>
      </div>

      {/* Difference indicator */}
      <div className="mt-3 flex items-center justify-center gap-2">
        <span className="text-xs text-muted-foreground">
          {t('metrics.crossValidation', 'Cross Validation')}
        </span>
        <span className="text-muted-foreground">←→</span>
        {difference != null ? (
          <div className="flex items-center gap-1">
            <span
              className={`text-sm font-medium ${isAlert ? 'text-orange-600' : 'text-green-600'}`}
            >
              {t('metrics.difference', 'Difference')}: {(difference * 100).toFixed(1)}%
            </span>
            {isAlert ? (
              <AlertTriangle className="h-4 w-4 text-orange-500" />
            ) : (
              <CheckCircle className="h-4 w-4 text-green-500" />
            )}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">-</span>
        )}
      </div>
    </div>
  )
}
