// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import type { RunInfo } from '../../api'
import { useRuns } from '../../hooks/useRuns'
import { RunRow } from './RunRow'

export function RunList() {
  const { t } = useTranslation('knowledge-stat')
  const { runs, total, page, totalPages, loading, error, goToPage, refresh } = useRuns()

  useEffect(() => {
    const handler = () => refresh()
    window.addEventListener('kb-stat:refresh-runs', handler)
    return () => window.removeEventListener('kb-stat:refresh-runs', handler)
  }, [refresh])

  if (loading && runs.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-text-muted text-sm">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        {t('loading')}
      </div>
    )
  }

  if (error && runs.length === 0) {
    return <div className="text-red-500 text-sm py-4">{error.message}</div>
  }

  if (runs.length === 0) {
    return <div className="text-text-muted text-sm py-4">{t('runs.list.empty')}</div>
  }

  return (
    <div className="space-y-3">
      {runs.map(run => (
        <RunRowWithState key={run.id} run={run} onRetried={refresh} />
      ))}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-text-muted">
            {t('runs.list.pagination', '{{start}}-{{end}} / {{total}}')
              .replace('{{start}}', String((page - 1) * 20 + 1))
              .replace('{{end}}', String(Math.min(page * 20, total)))
              .replace('{{total}}', String(total))}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || loading}
              onClick={() => goToPage(page - 1)}
              className="h-7 px-2"
              data-testid="pagination-prev"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            {renderPageButtons(page, totalPages, goToPage, loading)}
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || loading}
              onClick={() => goToPage(page + 1)}
              className="h-7 px-2"
              data-testid="pagination-next"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function renderPageButtons(
  current: number,
  total: number,
  goToPage: (p: number) => void,
  loading: boolean
) {
  const pages = getPageRange(current, total)
  return pages.map(p => {
    if (p === '...') {
      return (
        <span key={`ellipsis-${p}`} className="px-1 text-text-muted text-xs">
          ...
        </span>
      )
    }
    return (
      <Button
        key={p}
        variant={p === current ? 'primary' : 'outline'}
        size="sm"
        disabled={loading}
        onClick={() => goToPage(p as number)}
        className="h-7 w-7 px-0 text-xs"
        data-testid={`pagination-page-${p}`}
      >
        {p}
      </Button>
    )
  })
}

function getPageRange(current: number, total: number): (number | '...')[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }
  const pages: (number | '...')[] = [1]
  if (current > 3) pages.push('...')
  const start = Math.max(2, current - 1)
  const end = Math.min(total - 1, current + 1)
  for (let i = start; i <= end; i++) pages.push(i)
  if (current < total - 2) pages.push('...')
  pages.push(total)
  return pages
}

function RunRowWithState({ run, onRetried }: { run: RunInfo; onRetried: () => void }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <RunRow
      run={run}
      expanded={expanded}
      onToggle={() => setExpanded(prev => !prev)}
      onRetried={onRetried}
    />
  )
}
