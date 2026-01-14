'use client'

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ScoreCard } from '@/components/charts/score-card'
import { TrendChart } from '@/components/charts/trend-chart'
import {
  BarChart3,
  AlertTriangle,
  Loader2,
  ShieldAlert,
  Trophy,
  XCircle,
  Target,
  Zap,
  Search,
} from 'lucide-react'
import { getEvaluationSummary } from '@/apis/evaluation'
import { getTrends } from '@/apis/analytics'
import { EvaluationSummary, TrendDataPoint } from '@/types'
import { useVersion } from '@/contexts/VersionContext'

export default function DashboardPage() {
  const { t } = useTranslation()
  const { currentVersion } = useVersion()
  const [summary, setSummary] = useState<EvaluationSummary | null>(null)
  const [trendData, setTrendData] = useState<TrendDataPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Calculate date range for last 7 days
  const getDateRange = () => {
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - 7)
    return {
      start_date: start.toISOString(),
      end_date: end.toISOString(),
    }
  }

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const dateRange = getDateRange()
      const versionId = currentVersion?.id

      // Fetch summary and trends in parallel
      const [summaryData, trendsData] = await Promise.all([
        getEvaluationSummary({ ...dateRange, version_id: versionId }),
        getTrends({ ...dateRange, metric: 'overall', group_by: 'day', version_id: versionId }),
      ])

      setSummary(summaryData)
      setTrendData(trendsData.data || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data')
      // Set default values on error
      setSummary({
        total_evaluated: 0,
        avg_faithfulness: undefined,
        avg_answer_relevancy: undefined,
        avg_context_precision: undefined,
        avg_overall: undefined,
        issue_count: 0,
        issue_rate: 0,
        cv_alert_count: 0,
        cv_alert_rate: 0,
        avg_total_score: undefined,
        failed_count: 0,
        failed_rate: 0,
      })
      setTrendData([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [currentVersion])

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
      <h1 className="text-2xl font-semibold">{t('dashboard.title')}</h1>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          {error}
        </div>
      )}

      {/* Primary Stats Grid - Total Score + Key Stats */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-6">
        {/* Total Score Card - Prominent */}
        <div className="lg:col-span-2 rounded-lg border-2 border-primary/30 bg-primary/5 p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-full bg-primary/20 p-2">
              <Trophy className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                {t('metrics.totalScore', 'Total Score')}
              </p>
              <p className="text-3xl font-bold text-primary">
                {summary?.avg_total_score ? summary.avg_total_score.toFixed(1) : '-'}
                <span className="text-sm font-normal text-muted-foreground"> / 100</span>
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('metrics.hardThresholdWarning', 'Faithfulness or Groundedness < 60% = Failed')}
          </p>
        </div>

        {/* Total Evaluated */}
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-blue-100 p-2">
              <BarChart3 className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                {t('dashboard.evaluated')}
              </p>
              <p className="text-2xl font-semibold">
                {summary?.total_evaluated ?? 0}
              </p>
            </div>
          </div>
        </div>

        {/* Failed Samples */}
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-red-100 p-2">
              <XCircle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                {t('dashboard.failedSamples', 'Failed Samples')}
              </p>
              <p className="text-2xl font-semibold">
                {summary?.failed_count ?? 0}{' '}
                <span className="text-sm font-normal text-muted-foreground">
                  ({((summary?.failed_rate ?? 0) * 100).toFixed(1)}%)
                </span>
              </p>
            </div>
          </div>
        </div>

        {/* Issues */}
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-yellow-100 p-2">
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                {t('dashboard.issues')}
              </p>
              <p className="text-2xl font-semibold">
                {summary?.issue_count ?? 0}{' '}
                <span className="text-sm font-normal text-muted-foreground">
                  ({((summary?.issue_rate ?? 0) * 100).toFixed(1)}%)
                </span>
              </p>
            </div>
          </div>
        </div>

        {/* CV Alerts */}
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-purple-100 p-2">
              <ShieldAlert className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                {t('dashboard.cvAlerts')}
              </p>
              <p className="text-2xl font-semibold">
                {summary?.cv_alert_count ?? 0}{' '}
                <span className="text-sm font-normal text-muted-foreground">
                  ({((summary?.cv_alert_rate ?? 0) * 100).toFixed(1)}%)
                </span>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Core Metrics (Tier 1) - Most Important */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Target className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">{t('metrics.tiers.core', 'Core Metrics (Tier 1)')}</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <ScoreCard
            title={t('dashboard.avgFaithfulness')}
            score={summary?.avg_faithfulness ?? undefined}
            subtitle="RAGAS"
          />
          <ScoreCard
            title={t('resultDetail.groundedness', 'Groundedness')}
            score={summary?.avg_trulens_groundedness ?? undefined}
            subtitle="TruLens"
          />
          <ScoreCard
            title={t('resultDetail.queryContextRelevance', 'Query Context Relevance')}
            score={summary?.avg_ragas_query_context_relevance ?? undefined}
            subtitle="RAGAS"
          />
          <ScoreCard
            title={t('resultDetail.contextRelevance', 'Context Relevance')}
            score={summary?.avg_trulens_context_relevance ?? undefined}
            subtitle="TruLens"
          />
        </div>
      </div>

      {/* Key Metrics (Tier 2) */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-yellow-600" />
          <h2 className="text-lg font-semibold">{t('metrics.tiers.key', 'Key Metrics (Tier 2)')}</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <ScoreCard
            title={t('dashboard.avgAnswerRelevancy')}
            score={summary?.avg_answer_relevancy ?? undefined}
            subtitle="RAGAS"
          />
          <ScoreCard
            title={t('resultDetail.relevanceLlm', 'Relevance (LLM)')}
            score={summary?.avg_trulens_relevance_llm ?? undefined}
            subtitle="TruLens"
          />
          <ScoreCard
            title={t('resultDetail.contextPrecision', 'Context Precision')}
            score={summary?.avg_ragas_context_precision_emb ?? undefined}
            subtitle="RAGAS (Embedding)"
          />
        </div>
      </div>

      {/* Legacy Overall Score */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Search className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold text-muted-foreground">
            {t('metrics.tiers.diagnostic', 'Diagnostic Metrics (Tier 3)')}
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <ScoreCard
            title={t('dashboard.avgContextPrecision')}
            score={summary?.avg_context_precision ?? undefined}
            subtitle="RAGAS (LLM)"
          />
          <ScoreCard
            title={t('dashboard.avgOverall')}
            score={summary?.avg_overall ?? undefined}
            subtitle="Legacy"
          />
        </div>
      </div>

      {/* Trend Chart */}
      <div className="rounded-lg border bg-card p-4">
        <h2 className="mb-4 text-lg font-semibold">{t('dashboard.recentTrend')}</h2>
        {trendData.length > 0 ? (
          <TrendChart data={trendData} />
        ) : (
          <div className="flex h-[300px] items-center justify-center text-muted-foreground">
            {t('common.noData')}
          </div>
        )}
      </div>
    </div>
  )
}
