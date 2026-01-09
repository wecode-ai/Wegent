'use client'

import { useState, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp } from 'lucide-react'
import {
  MetricTier,
  MetricMeta,
  getCrossValidationPairs,
  getStandaloneMetrics,
  METRICS_CONFIG,
} from '@/types'
import { CrossValidationPairCard } from './cross-validation-pair-card'
import { MetricCard } from './metric-card'

interface TieredMetricsSectionProps {
  tier: MetricTier
  title: string
  icon: ReactNode
  defaultExpanded?: boolean
  scores: Record<string, number | undefined>
  showThresholdWarning?: boolean
}

// Cross-validation pair labels by metric key
const PAIR_LABELS: Record<string, { en: string; zh: string }> = {
  ragas_query_context_relevance: {
    en: 'Retrieval Relevance',
    zh: '检索相关性',
  },
  faithfulness_score: {
    en: 'Generation Faithfulness',
    zh: '生成可信度',
  },
  answer_relevancy_score: {
    en: 'Answer Relevance',
    zh: '答案相关性',
  },
  ragas_coherence: {
    en: 'Coherence',
    zh: '表达连贯性',
  },
}

export function TieredMetricsSection({
  tier,
  title,
  icon,
  defaultExpanded = false,
  scores,
  showThresholdWarning = false,
}: TieredMetricsSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const { i18n } = useTranslation()
  const isZh = i18n.language?.startsWith('zh')

  // Get cross-validation pairs and standalone metrics for this tier
  const pairs = getCrossValidationPairs(tier)
  const standaloneMetrics = getStandaloneMetrics(tier)

  // Hard threshold metrics
  const hardThresholdMetrics = ['faithfulness_score', 'trulens_groundedness']

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      {/* Header - clickable to toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-secondary/30 transition-colors"
      >
        <div className="flex items-center gap-3">
          {icon}
          <h3 className="font-semibold text-lg">{title}</h3>
          <span className="text-xs text-muted-foreground px-2 py-0.5 bg-secondary rounded-full">
            {pairs.length * 2 + standaloneMetrics.length} metrics
          </span>
        </div>
        {expanded ? (
          <ChevronUp className="h-5 w-5 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-5 w-5 text-muted-foreground" />
        )}
      </button>

      {/* Content */}
      {expanded && (
        <div className="border-t p-4 space-y-4">
          {/* Cross-validation pairs */}
          {pairs.map(([ragasMetric, trulensMetric], index) => {
            const labelConfig = PAIR_LABELS[ragasMetric.key]
            const label = labelConfig ? (isZh ? labelConfig.zh : labelConfig.en) : undefined

            // Determine if this pair needs hard threshold warning
            const showHardThreshold =
              showThresholdWarning &&
              (hardThresholdMetrics.includes(ragasMetric.key) ||
                hardThresholdMetrics.includes(trulensMetric.key))

            return (
              <CrossValidationPairCard
                key={`${ragasMetric.key}-${trulensMetric.key}`}
                ragasMetric={ragasMetric}
                trulensMetric={trulensMetric}
                ragasScore={scores[ragasMetric.key]}
                trulensScore={scores[trulensMetric.key]}
                label={label}
                showThresholdWarning={showHardThreshold}
                hardThreshold={0.6}
              />
            )
          })}

          {/* Standalone metrics in grid */}
          {standaloneMetrics.length > 0 && (
            <div className="pt-2">
              {pairs.length > 0 && (
                <p className="text-xs text-muted-foreground mb-2">
                  {isZh ? '独立指标（无交叉验证对）' : 'Standalone Metrics (No Cross-Validation)'}
                </p>
              )}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {standaloneMetrics.map((metric) => (
                  <MetricCard
                    key={metric.key}
                    metric={metric}
                    score={scores[metric.key]}
                    size="sm"
                    showDescription={true}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
