'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { getRetrieverComparison, getEmbeddingComparison, getContextComparison } from '@/apis/analytics'
import { Loader2, Search } from 'lucide-react'
import { useVersion } from '@/contexts/VersionContext'

interface ComparisonData {
  name: string
  faithfulness: number
  answer_relevancy: number
  context_precision: number
  overall: number
}

interface ContextComparisonResult {
  retriever_name: string
  embedding_model: string
  faithfulness_score: number
  answer_relevancy_score: number
  context_precision_score: number
  overall_score: number
}

export default function ComparisonPage() {
  const { t } = useTranslation()
  const { currentVersion } = useVersion()
  const [retrieverData, setRetrieverData] = useState<ComparisonData[]>([])
  const [embeddingData, setEmbeddingData] = useState<ComparisonData[]>([])
  const [contextResults, setContextResults] = useState<ContextComparisonResult[]>([])
  const [loading, setLoading] = useState(true)
  const [contextLoading, setContextLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [contextError, setContextError] = useState<string | null>(null)

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
  const [contextId, setContextId] = useState('')

  const fetchComparisons = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [retrieverResult, embeddingResult] = await Promise.all([
        getRetrieverComparison({ start_date: startDate, end_date: endDate, version_id: currentVersion?.id }),
        getEmbeddingComparison({ start_date: startDate, end_date: endDate, version_id: currentVersion?.id }),
      ])

      // Transform retriever data
      const transformedRetriever = (retrieverResult.data || []).map((item: {
        retriever_name: string
        avg_faithfulness: number
        avg_answer_relevancy: number
        avg_context_precision: number
        avg_overall: number
      }) => ({
        name: item.retriever_name || 'Unknown',
        faithfulness: item.avg_faithfulness || 0,
        answer_relevancy: item.avg_answer_relevancy || 0,
        context_precision: item.avg_context_precision || 0,
        overall: item.avg_overall || 0,
      }))
      setRetrieverData(transformedRetriever)

      // Transform embedding data
      const transformedEmbedding = (embeddingResult.data || []).map((item: {
        embedding_model: string
        avg_faithfulness: number
        avg_answer_relevancy: number
        avg_context_precision: number
        avg_overall: number
      }) => ({
        name: item.embedding_model || 'Unknown',
        faithfulness: item.avg_faithfulness || 0,
        answer_relevancy: item.avg_answer_relevancy || 0,
        context_precision: item.avg_context_precision || 0,
        overall: item.avg_overall || 0,
      }))
      setEmbeddingData(transformedEmbedding)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch comparisons')
    } finally {
      setLoading(false)
    }
  }, [startDate, endDate, currentVersion])

  useEffect(() => {
    fetchComparisons()
  }, [currentVersion])

  const handleApply = () => {
    fetchComparisons()
  }

  const handleContextSearch = async () => {
    if (!contextId.trim()) return
    setContextLoading(true)
    setContextError(null)
    try {
      const result = await getContextComparison(parseInt(contextId))
      setContextResults(result.results || [])
    } catch (err) {
      setContextError(err instanceof Error ? err.message : 'Failed to fetch context comparison')
      setContextResults([])
    } finally {
      setContextLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('comparison.title')}</h1>

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

      {/* By Retriever */}
      <div className="rounded-lg border bg-card p-4">
        <h2 className="mb-4 text-lg font-semibold">{t('comparison.byRetriever')}</h2>
        {loading ? (
          <div className="flex h-[300px] items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : retrieverData.length > 0 ? (
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={retrieverData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis domain={[0, 1]} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
                <Tooltip formatter={(v: number) => `${(v * 100).toFixed(1)}%`} />
                <Legend />
                <Bar dataKey="faithfulness" fill="#3B82F6" name={t('results.faithfulness')} />
                <Bar dataKey="answer_relevancy" fill="#10B981" name={t('results.answerRelevancy')} />
                <Bar dataKey="context_precision" fill="#F59E0B" name={t('results.contextPrecision')} />
                <Bar dataKey="overall" fill="#14B8A6" name={t('results.overall')} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-[300px] items-center justify-center text-muted-foreground">
            {t('common.noData')}
          </div>
        )}
      </div>

      {/* By Embedding Model */}
      <div className="rounded-lg border bg-card p-4">
        <h2 className="mb-4 text-lg font-semibold">{t('comparison.byEmbedding')}</h2>
        {loading ? (
          <div className="flex h-[300px] items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : embeddingData.length > 0 ? (
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={embeddingData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis domain={[0, 1]} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
                <Tooltip formatter={(v: number) => `${(v * 100).toFixed(1)}%`} />
                <Legend />
                <Bar dataKey="faithfulness" fill="#3B82F6" name={t('results.faithfulness')} />
                <Bar dataKey="answer_relevancy" fill="#10B981" name={t('results.answerRelevancy')} />
                <Bar dataKey="context_precision" fill="#F59E0B" name={t('results.contextPrecision')} />
                <Bar dataKey="overall" fill="#14B8A6" name={t('results.overall')} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-[300px] items-center justify-center text-muted-foreground">
            {t('common.noData')}
          </div>
        )}
      </div>

      {/* Context Comparison */}
      <div className="rounded-lg border bg-card p-4">
        <h2 className="mb-4 text-lg font-semibold">{t('comparison.byContext')}</h2>
        <div className="flex gap-4">
          <input
            type="number"
            value={contextId}
            onChange={(e) => setContextId(e.target.value)}
            placeholder={t('comparison.contextIdPlaceholder')}
            className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
          />
          <button
            onClick={handleContextSearch}
            disabled={contextLoading || !contextId.trim()}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {contextLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            {t('common.search')}
          </button>
        </div>

        {contextError && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {contextError}
          </div>
        )}

        {contextResults.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-2 text-left font-medium">{t('results.retriever')}</th>
                  <th className="py-2 text-left font-medium">{t('results.embeddingModel')}</th>
                  <th className="py-2 text-center font-medium">{t('results.faithfulness')}</th>
                  <th className="py-2 text-center font-medium">{t('results.answerRelevancy')}</th>
                  <th className="py-2 text-center font-medium">{t('results.contextPrecision')}</th>
                  <th className="py-2 text-center font-medium">{t('results.overall')}</th>
                </tr>
              </thead>
              <tbody>
                {contextResults.map((result, index) => (
                  <tr key={index} className="border-b">
                    <td className="py-2">{result.retriever_name || '-'}</td>
                    <td className="py-2">{result.embedding_model || '-'}</td>
                    <td className="py-2 text-center">
                      {result.faithfulness_score != null
                        ? `${(result.faithfulness_score * 100).toFixed(1)}%`
                        : '-'}
                    </td>
                    <td className="py-2 text-center">
                      {result.answer_relevancy_score != null
                        ? `${(result.answer_relevancy_score * 100).toFixed(1)}%`
                        : '-'}
                    </td>
                    <td className="py-2 text-center">
                      {result.context_precision_score != null
                        ? `${(result.context_precision_score * 100).toFixed(1)}%`
                        : '-'}
                    </td>
                    <td className="py-2 text-center">
                      {result.overall_score != null
                        ? `${(result.overall_score * 100).toFixed(1)}%`
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {t('comparison.contextHint')}
          </p>
        )}
      </div>
    </div>
  )
}
