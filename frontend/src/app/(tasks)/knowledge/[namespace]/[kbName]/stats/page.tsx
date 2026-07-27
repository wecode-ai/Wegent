// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import { useStatFilter } from '@/features/knowledge-stat/hooks/useStatFilter'
import { StatsPage } from '@/features/knowledge-stat/components/StatsPage'
import type { MetricFilter } from '@/features/knowledge-stat/api'

export default function KbStatsPage() {
  const { t } = useTranslation('knowledge-stat')
  const { filter, setStartDate, setEndDate } = useStatFilter()

  const metricFilter: MetricFilter = {
    start_date: filter.startDate,
    end_date: filter.endDate,
  }

  return (
    <div className="p-4 md:p-8 space-y-6" data-testid="kb-stats-page">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('page_title')}</h1>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm text-text-secondary">{t('filter.start_date')}</label>
            <input
              type="date"
              value={filter.startDate}
              onChange={e => setStartDate(e.target.value)}
              className="rounded-md border border-border bg-base px-3 py-1.5 text-sm"
              data-testid="stats-filter-date-from"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-text-secondary">{t('filter.end_date')}</label>
            <input
              type="date"
              value={filter.endDate}
              onChange={e => setEndDate(e.target.value)}
              className="rounded-md border border-border bg-base px-3 py-1.5 text-sm"
              data-testid="stats-filter-date-to"
            />
          </div>
        </div>
      </div>

      <hr className="border-border" />

      {/* Domain-level metrics */}
      <StatsPage scope="admin" filter={metricFilter} hideDashboard />
    </div>
  )
}
