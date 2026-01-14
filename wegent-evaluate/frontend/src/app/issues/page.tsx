'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { IssuePieChart } from '@/components/charts/pie-chart'
import { ResultsTable } from '@/components/tables/results-table'
import { getIssuesAnalytics } from '@/apis/analytics'
import { getEvaluationResults } from '@/apis/evaluation'
import { Loader2, X } from 'lucide-react'
import { EvaluationResultItem } from '@/types'
import { useVersion } from '@/contexts/VersionContext'

interface IssueData {
  name: string
  value: number
  percentage: number
  issueType: string // Original issue type key for filtering
}

export default function IssuesPage() {
  const { t } = useTranslation()
  const { currentVersion } = useVersion()
  const [issueData, setIssueData] = useState<IssueData[]>([])
  const [issueRecords, setIssueRecords] = useState<EvaluationResultItem[]>([])
  const [loading, setLoading] = useState(true)
  const [recordsLoading, setRecordsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIssueType, setSelectedIssueType] = useState<string | null>(null)
  const [selectedIssueName, setSelectedIssueName] = useState<string | null>(null)

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

  // Issue type translation mapping
  const getIssueTypeLabel = (issueType: string): string => {
    const labels: Record<string, string> = {
      retrieval_miss: t('issues.retrieval_miss'),
      retrieval_irrelevant: t('issues.retrieval_irrelevant'),
      answer_hallucination: t('issues.answer_hallucination'),
      answer_incomplete: t('issues.answer_incomplete'),
      answer_irrelevant: t('issues.answer_irrelevant'),
      knowledge_gap: t('issues.knowledge_gap'),
      incomplete_answer: t('issues.incomplete_answer'),
    }
    return labels[issueType] || issueType
  }

  // Fetch issue records with optional issue type filter
  const fetchIssueRecords = useCallback(
    async (issueType: string | null) => {
      setRecordsLoading(true)
      try {
        const recordsResult = await getEvaluationResults({
          start_date: startDate,
          end_date: endDate,
          has_issue: true,
          page_size: 20,
          issue_type: issueType || undefined,
          version_id: currentVersion?.id,
        })
        setIssueRecords(recordsResult.items || [])
      } catch (err) {
        console.error('Failed to fetch issue records:', err)
      } finally {
        setRecordsLoading(false)
      }
    },
    [startDate, endDate, currentVersion]
  )

  const fetchIssues = useCallback(async () => {
    setLoading(true)
    setError(null)
    setSelectedIssueType(null)
    setSelectedIssueName(null)
    try {
      const [analyticsResult, recordsResult] = await Promise.all([
        getIssuesAnalytics({ start_date: startDate, end_date: endDate, version_id: currentVersion?.id }),
        getEvaluationResults({
          start_date: startDate,
          end_date: endDate,
          has_issue: true,
          page_size: 20,
          version_id: currentVersion?.id,
        }),
      ])

      // Transform issue analytics data with original issue type key
      const issues = analyticsResult.by_type || []
      const transformedIssues = issues.map(
        (issue: { type: string; count: number; percentage: number }) => ({
          name: getIssueTypeLabel(issue.type),
          value: issue.count,
          percentage: issue.percentage,
          issueType: issue.type, // Keep original key for filtering
        })
      )
      setIssueData(transformedIssues)

      // Set issue records
      setIssueRecords(recordsResult.items || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch issues')
    } finally {
      setLoading(false)
    }
  }, [startDate, endDate, currentVersion])

  useEffect(() => {
    fetchIssues()
  }, [currentVersion])

  const handleApply = () => {
    fetchIssues()
  }

  // Handle pie chart slice click
  const handleSliceClick = useCallback(
    (issueType: string | null, name: string | null) => {
      setSelectedIssueType(issueType)
      setSelectedIssueName(name)
      fetchIssueRecords(issueType)
    },
    [fetchIssueRecords]
  )

  // Clear filter
  const handleClearFilter = useCallback(() => {
    setSelectedIssueType(null)
    setSelectedIssueName(null)
    fetchIssueRecords(null)
  }, [fetchIssueRecords])

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('issues.title')}</h1>

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

      {/* Summary */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Pie Chart */}
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{t('issues.distribution')}</h2>
            {selectedIssueType && (
              <span className="text-sm text-muted-foreground">
                {t('issues.clickToFilter')}
              </span>
            )}
          </div>
          {loading ? (
            <div className="flex h-[300px] items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : issueData.length > 0 ? (
            <IssuePieChart
              data={issueData}
              onSliceClick={handleSliceClick}
              selectedIssueType={selectedIssueType}
            />
          ) : (
            <div className="flex h-[300px] items-center justify-center text-muted-foreground">
              {t('common.noData')}
            </div>
          )}
        </div>

        {/* Issue Counts */}
        <div className="rounded-lg border bg-card p-4">
          <h2 className="mb-4 text-lg font-semibold">{t('issues.breakdown')}</h2>
          {loading ? (
            <div className="flex h-[300px] items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : issueData.length > 0 ? (
            <div className="space-y-3">
              {issueData.map((issue, index) => (
                <div
                  key={index}
                  onClick={() => handleSliceClick(issue.issueType, issue.name)}
                  className={`flex cursor-pointer items-center justify-between rounded p-3 transition-colors hover:bg-secondary/80 ${
                    selectedIssueType === issue.issueType
                      ? 'bg-primary/10 ring-2 ring-primary'
                      : 'bg-secondary'
                  }`}
                >
                  <span className="text-sm">{issue.name}</span>
                  <div className="flex items-center gap-4">
                    <span className="text-sm font-medium">{issue.value}</span>
                    <span className="text-sm text-muted-foreground">
                      ({(issue.percentage * 100).toFixed(1)}%)
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-[300px] items-center justify-center text-muted-foreground">
              {t('common.noData')}
            </div>
          )}
        </div>
      </div>

      {/* Issue Records Table */}
      <div className="rounded-lg border bg-card p-4">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold">{t('issues.recordsWithIssues')}</h2>
            {selectedIssueName && (
              <div className="flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-sm text-primary">
                <span>{t('issues.filterBy')}: {selectedIssueName}</span>
                <button
                  onClick={handleClearFilter}
                  className="rounded-full p-0.5 hover:bg-primary/20"
                  title={t('issues.clearFilter')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
          {recordsLoading && (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          )}
        </div>
        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : issueRecords.length > 0 ? (
          <ResultsTable items={issueRecords} />
        ) : (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            {selectedIssueType ? t('issues.noRecordsForType') : t('common.noData')}
          </div>
        )}
      </div>
    </div>
  )
}
