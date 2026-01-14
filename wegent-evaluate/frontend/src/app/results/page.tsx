'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ResultsTable } from '@/components/tables/results-table'
import { EvaluationResultItem, PaginatedResponse } from '@/types'
import { Search, Filter, Loader2, ChevronLeft, ChevronRight } from 'lucide-react'
import { getEvaluationResults } from '@/apis/evaluation'
import { useVersion } from '@/contexts/VersionContext'

interface Filters {
  start_date: string
  end_date: string
  evaluation_status: string
  has_issue: string
}

export default function ResultsPage() {
  const { t } = useTranslation()
  const { currentVersion } = useVersion()
  const [results, setResults] = useState<EvaluationResultItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const pageSize = 20

  const [filters, setFilters] = useState<Filters>({
    start_date: '',
    end_date: '',
    evaluation_status: '',
    has_issue: '',
  })

  const fetchResults = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, unknown> = {
        page,
        page_size: pageSize,
      }

      if (filters.start_date) {
        params.start_date = new Date(filters.start_date).toISOString()
      }
      if (filters.end_date) {
        params.end_date = new Date(filters.end_date).toISOString()
      }
      if (filters.evaluation_status) {
        params.evaluation_status = filters.evaluation_status
      }
      if (filters.has_issue) {
        params.has_issue = filters.has_issue === 'true'
      }
      if (currentVersion?.id) {
        params.version_id = currentVersion.id
      }

      const data: PaginatedResponse<EvaluationResultItem> =
        await getEvaluationResults(params)
      setResults(data.items || [])
      setTotalPages(data.total_pages || 1)
      setTotal(data.total || 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch results')
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [page, filters, currentVersion])

  useEffect(() => {
    fetchResults()
  }, [fetchResults])

  const handleSearch = () => {
    setPage(1)
    fetchResults()
  }

  const handleFilterChange = (key: keyof Filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setPage(newPage)
    }
  }

  const startItem = (page - 1) * pageSize + 1
  const endItem = Math.min(page * pageSize, total)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('results.title')}</h1>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{t('results.filters')}:</span>
        </div>
        <div className="flex flex-1 flex-wrap gap-3">
          <input
            type="date"
            value={filters.start_date}
            onChange={(e) => handleFilterChange('start_date', e.target.value)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          />
          <input
            type="date"
            value={filters.end_date}
            onChange={(e) => handleFilterChange('end_date', e.target.value)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          />
          <select
            value={filters.evaluation_status}
            onChange={(e) => handleFilterChange('evaluation_status', e.target.value)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">{t('results.status')} - All</option>
            <option value="pending">Pending</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="skipped">Skipped</option>
          </select>
          <select
            value={filters.has_issue}
            onChange={(e) => handleFilterChange('has_issue', e.target.value)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">{t('results.hasIssue')} - All</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
          <button
            onClick={handleSearch}
            className="flex items-center gap-1 rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
          >
            <Search className="h-4 w-4" /> {t('common.search')}
          </button>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <span className="ml-2">{t('common.loading')}</span>
        </div>
      ) : results.length > 0 ? (
        <>
          {/* Results Table */}
          <ResultsTable items={results} />

          {/* Pagination */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              Showing {startItem}-{endItem} of {total} results
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => handlePageChange(page - 1)}
                disabled={page <= 1}
                className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-secondary disabled:opacity-50"
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </button>
              <span className="flex items-center px-3 py-1.5 text-sm">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => handlePageChange(page + 1)}
                disabled={page >= totalPages}
                className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-secondary disabled:opacity-50"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="flex h-64 items-center justify-center text-muted-foreground">
          {t('common.noData')}
        </div>
      )}
    </div>
  )
}
