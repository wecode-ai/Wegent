'use client'

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { getMetricsDocumentation } from '@/apis/evaluation'
import { MetricDocumentation } from '@/types'
import {
  Loader2,
  ChevronDown,
  ChevronRight,
  Brain,
  Cpu,
  Info,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react'

type Framework = 'all' | 'ragas' | 'trulens'
type SignalSource = 'all' | 'embedding' | 'llm'

function getScoreColor(score: number): string {
  if (score >= 0.8) return 'text-green-600'
  if (score >= 0.6) return 'text-yellow-600'
  if (score >= 0.4) return 'text-orange-600'
  return 'text-red-600'
}

function ScoreInterpretationBadge({
  label,
  min,
  colorClass,
}: {
  label: string
  min: number
  colorClass: string
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${colorClass}`}
    >
      {label}: ≥{min.toFixed(1)}
    </span>
  )
}

function MetricCard({
  metric,
  expanded,
  onToggle,
}: {
  metric: MetricDocumentation
  expanded: boolean
  onToggle: () => void
}) {
  const { i18n } = useTranslation()
  const isZh = i18n.language === 'zh-CN'

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 hover:bg-secondary/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          {metric.signal_source === 'embedding' ? (
            <div className="rounded-full bg-blue-100 p-2">
              <Cpu className="h-4 w-4 text-blue-600" />
            </div>
          ) : (
            <div className="rounded-full bg-purple-100 p-2">
              <Brain className="h-4 w-4 text-purple-600" />
            </div>
          )}
          <div className="text-left">
            <h3 className="font-medium">
              {isZh ? metric.name_zh : metric.name}
            </h3>
            <div className="flex items-center gap-2 mt-1">
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  metric.framework === 'ragas'
                    ? 'bg-green-100 text-green-700'
                    : 'bg-blue-100 text-blue-700'
                }`}
              >
                {metric.framework.toUpperCase()}
              </span>
              <span className="text-xs text-muted-foreground">
                {metric.signal_source === 'embedding' ? 'Embedding-based' : 'LLM-based'}
              </span>
            </div>
          </div>
        </div>
        {expanded ? (
          <ChevronDown className="h-5 w-5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-5 w-5 text-muted-foreground" />
        )}
      </button>

      {/* Expanded Content */}
      {expanded && (
        <div className="border-t p-4 space-y-4">
          {/* Description */}
          <div>
            <h4 className="text-sm font-medium text-muted-foreground mb-1">
              Description
            </h4>
            <p className="text-sm">
              {isZh ? metric.description_zh : metric.description}
            </p>
          </div>

          {/* Implementation */}
          <div>
            <h4 className="text-sm font-medium text-muted-foreground mb-1">
              Implementation
            </h4>
            <p className="text-sm">
              {isZh ? metric.implementation_zh : metric.implementation}
            </p>
          </div>

          {/* Formula */}
          {metric.formula && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-1">
                Formula
              </h4>
              <code className="block bg-secondary rounded p-2 text-sm font-mono">
                {metric.formula}
              </code>
            </div>
          )}

          {/* Score Range */}
          <div>
            <h4 className="text-sm font-medium text-muted-foreground mb-1">
              Score Range
            </h4>
            <div className="flex items-center gap-2 text-sm">
              <span>
                {metric.score_range.min} - {metric.score_range.max}
              </span>
              <span className="text-muted-foreground">
                ({metric.score_range.direction === 'higher_better'
                  ? 'Higher is better'
                  : 'Lower is better'})
              </span>
            </div>
          </div>

          {/* Score Interpretation */}
          <div>
            <h4 className="text-sm font-medium text-muted-foreground mb-2">
              Interpretation
            </h4>
            <div className="flex flex-wrap gap-2">
              <ScoreInterpretationBadge
                label="Excellent"
                min={metric.interpretation.excellent.min}
                colorClass="bg-green-100 text-green-700"
              />
              <ScoreInterpretationBadge
                label="Good"
                min={metric.interpretation.good.min}
                colorClass="bg-blue-100 text-blue-700"
              />
              <ScoreInterpretationBadge
                label="Fair"
                min={metric.interpretation.fair.min}
                colorClass="bg-yellow-100 text-yellow-700"
              />
              <ScoreInterpretationBadge
                label="Poor"
                min={metric.interpretation.poor.min}
                colorClass="bg-red-100 text-red-700"
              />
            </div>
          </div>

          {/* Cross-validation Pair */}
          {metric.cross_validation_pair && (
            <div className="flex items-start gap-2 p-3 bg-secondary/50 rounded-lg">
              <Info className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <div className="text-sm">
                <span className="font-medium">Cross-validation Pair: </span>
                <span className="text-muted-foreground">
                  {metric.cross_validation_pair.paired_metric} (
                  {metric.cross_validation_pair.paired_framework.toUpperCase()})
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function MetricsDocsPage() {
  const { t } = useTranslation()
  const [metrics, setMetrics] = useState<MetricDocumentation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [framework, setFramework] = useState<Framework>('all')
  const [signalSource, setSignalSource] = useState<SignalSource>('all')
  const [expandedMetrics, setExpandedMetrics] = useState<Set<string>>(new Set())

  const fetchMetrics = async () => {
    setLoading(true)
    setError(null)
    try {
      const params: { framework?: 'ragas' | 'trulens'; signal_source?: 'embedding' | 'llm' } = {}
      if (framework !== 'all') params.framework = framework
      if (signalSource !== 'all') params.signal_source = signalSource

      const data = await getMetricsDocumentation(params)
      setMetrics(data.metrics || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch metrics')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchMetrics()
  }, [framework, signalSource])

  const toggleMetric = (id: string) => {
    setExpandedMetrics((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const expandAll = () => {
    setExpandedMetrics(new Set(metrics.map((m) => m.id)))
  }

  const collapseAll = () => {
    setExpandedMetrics(new Set())
  }

  // Group metrics by framework
  const ragasMetrics = metrics.filter((m) => m.framework === 'ragas')
  const trulensMetrics = metrics.filter((m) => m.framework === 'trulens')

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2">{t('common.loading')}</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('metricsDocs.title')}</h1>
        <div className="flex gap-2">
          <button
            onClick={expandAll}
            className="text-sm text-primary hover:underline"
          >
            {t('metricsDocs.expandAll')}
          </button>
          <span className="text-muted-foreground">|</span>
          <button
            onClick={collapseAll}
            className="text-sm text-primary hover:underline"
          >
            {t('metricsDocs.collapseAll')}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4">
        {/* Framework Filter */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Framework:</span>
          <div className="flex rounded-md border">
            {(['all', 'ragas', 'trulens'] as Framework[]).map((f) => (
              <button
                key={f}
                onClick={() => setFramework(f)}
                className={`px-3 py-1.5 text-sm transition-colors ${
                  framework === f
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-secondary'
                } ${f === 'all' ? 'rounded-l-md' : ''} ${
                  f === 'trulens' ? 'rounded-r-md' : ''
                }`}
              >
                {f === 'all' ? 'All' : f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Signal Source Filter */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Signal Source:</span>
          <div className="flex rounded-md border">
            {(['all', 'embedding', 'llm'] as SignalSource[]).map((s) => (
              <button
                key={s}
                onClick={() => setSignalSource(s)}
                className={`px-3 py-1.5 text-sm transition-colors ${
                  signalSource === s
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-secondary'
                } ${s === 'all' ? 'rounded-l-md' : ''} ${
                  s === 'llm' ? 'rounded-r-md' : ''
                }`}
              >
                {s === 'all' ? 'All' : s === 'embedding' ? 'Embedding' : 'LLM'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          {error}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-green-100 p-2">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Metrics</p>
              <p className="text-2xl font-semibold">{metrics.length}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-blue-100 p-2">
              <Cpu className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Embedding-based</p>
              <p className="text-2xl font-semibold">
                {metrics.filter((m) => m.signal_source === 'embedding').length}
              </p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-purple-100 p-2">
              <Brain className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">LLM-based</p>
              <p className="text-2xl font-semibold">
                {metrics.filter((m) => m.signal_source === 'llm').length}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* RAGAS Metrics */}
      {(framework === 'all' || framework === 'ragas') && ragasMetrics.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-green-100 text-green-700 text-sm">
              RAGAS
            </span>
            <span className="text-muted-foreground text-sm font-normal">
              ({ragasMetrics.length} metrics)
            </span>
          </h2>
          <div className="grid gap-4">
            {ragasMetrics.map((metric) => (
              <MetricCard
                key={metric.id}
                metric={metric}
                expanded={expandedMetrics.has(metric.id)}
                onToggle={() => toggleMetric(metric.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* TruLens Metrics */}
      {(framework === 'all' || framework === 'trulens') &&
        trulensMetrics.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-sm">
                TruLens
              </span>
              <span className="text-muted-foreground text-sm font-normal">
                ({trulensMetrics.length} metrics)
              </span>
            </h2>
            <div className="grid gap-4">
              {trulensMetrics.map((metric) => (
                <MetricCard
                  key={metric.id}
                  metric={metric}
                  expanded={expandedMetrics.has(metric.id)}
                  onToggle={() => toggleMetric(metric.id)}
                />
              ))}
            </div>
          </div>
        )}

      {/* No Results */}
      {metrics.length === 0 && !loading && (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <AlertCircle className="h-12 w-12 mb-4" />
          <p>{t('common.noData')}</p>
        </div>
      )}
    </div>
  )
}
