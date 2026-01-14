'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { TrendChart } from '@/components/charts/trend-chart'
import { getTrends } from '@/apis/analytics'
import { Loader2 } from 'lucide-react'
import { useVersion } from '@/contexts/VersionContext'

interface TrendDataPoint {
  date: string
  avg_score: number
  count: number
}

export default function TrendsPage() {
  const { t } = useTranslation()
  const { currentVersion } = useVersion()
  const [trendData, setTrendData] = useState<TrendDataPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Default to last 30 days
  const getDefaultDates = () => {
    const endDate = new Date()
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - 30)
    return {
      start: startDate.toISOString().split('T')[0],
      end: endDate.toISOString().split('T')[0],
    }
  }

  const defaultDates = getDefaultDates()
  const [startDate, setStartDate] = useState(defaultDates.start)
  const [endDate, setEndDate] = useState(defaultDates.end)
  const [metric, setMetric] = useState<'faithfulness' | 'answer_relevancy' | 'context_precision' | 'overall'>('overall')
  const [groupBy, setGroupBy] = useState<'day' | 'week' | 'month'>('day')

  const fetchTrends = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getTrends({
        start_date: startDate,
        end_date: endDate,
        metric,
        group_by: groupBy,
        version_id: currentVersion?.id,
      })
      setTrendData(data.data || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch trends')
      setTrendData([])
    } finally {
      setLoading(false)
    }
  }, [startDate, endDate, metric, groupBy, currentVersion])

  useEffect(() => {
    fetchTrends()
  }, [currentVersion])

  const handleApply = () => {
    fetchTrends()
  }

  // Calculate statistics from trend data
  const statistics = {
    avgScore: trendData.length > 0
      ? (trendData.reduce((sum, d) => sum + d.avg_score, 0) / trendData.length * 100).toFixed(1)
      : '0.0',
    highestScore: trendData.length > 0
      ? (Math.max(...trendData.map(d => d.avg_score)) * 100).toFixed(1)
      : '0.0',
    lowestScore: trendData.length > 0
      ? (Math.min(...trendData.map(d => d.avg_score)) * 100).toFixed(1)
      : '0.0',
    totalEvaluated: trendData.reduce((sum, d) => sum + d.count, 0),
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('trends.title')}</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">{t('results.dateRange')}:</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          />
          <span>{t('common.to')}</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">{t('trends.metric')}:</label>
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as typeof metric)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            <option value="overall">{t('results.overall')}</option>
            <option value="faithfulness">{t('results.faithfulness')}</option>
            <option value="answer_relevancy">{t('results.answerRelevancy')}</option>
            <option value="context_precision">{t('results.contextPrecision')}</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">{t('trends.groupBy')}:</label>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            <option value="day">{t('trends.day')}</option>
            <option value="week">{t('trends.week')}</option>
            <option value="month">{t('trends.month')}</option>
          </select>
        </div>
        <button
          onClick={handleApply}
          disabled={loading}
          className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? t('common.loading') : t('common.apply')}
        </button>
      </div>

      {/* Error display */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          {error}
        </div>
      )}

      {/* Chart */}
      <div className="rounded-lg border bg-card p-4">
        <h2 className="mb-4 text-lg font-semibold">{t('trends.scoreTrend')}</h2>
        {loading ? (
          <div className="flex h-[300px] items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : trendData.length > 0 ? (
          <TrendChart data={trendData} />
        ) : (
          <div className="flex h-[300px] items-center justify-center text-muted-foreground">
            {t('common.noData')}
          </div>
        )}
      </div>

      {/* Statistics */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm text-muted-foreground">{t('trends.avgScore')}</h3>
          <p className="text-2xl font-semibold">{statistics.avgScore}%</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm text-muted-foreground">{t('trends.highestScore')}</h3>
          <p className="text-2xl font-semibold">{statistics.highestScore}%</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm text-muted-foreground">{t('trends.lowestScore')}</h3>
          <p className="text-2xl font-semibold">{statistics.lowestScore}%</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm text-muted-foreground">{t('trends.totalEvaluated')}</h3>
          <p className="text-2xl font-semibold">{statistics.totalEvaluated}</p>
        </div>
      </div>
    </div>
  )
}
