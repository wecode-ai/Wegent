// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { CalendarDays, BarChart3, History } from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'
import { useStatFilter } from '../../hooks/useStatFilter'
import { DashboardSection } from './DashboardSection'
import { QualityAlertPanel } from './QualityAlertPanel'
import { StatsPage } from '../StatsPage'
import { StatRunsPanel } from './StatRunsPanel'
import type { MetricFilter } from '../../api'

type SubTab = 'statistics' | 'runs'

export function KnowledgeStatsAdminPanel() {
  const { t } = useTranslation('knowledge-stat')
  const { filter, setStartDate, setEndDate } = useStatFilter()
  const [subTab, setSubTab] = useState<SubTab>('statistics')

  const metricFilter: MetricFilter = {
    start_date: filter.startDate,
    end_date: filter.endDate,
  }

  return (
    <div className="space-y-6" data-testid="kb-stats-page">
      {/* Sub-tab switcher */}
      <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1">
        <button
          type="button"
          onClick={() => setSubTab('statistics')}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            subTab === 'statistics'
              ? 'bg-primary/10 text-primary'
              : 'text-text-secondary hover:text-text-primary hover:bg-muted'
          }`}
          data-testid="subtab-statistics"
        >
          <BarChart3 className="h-4 w-4" />
          {t('subtabs.statistics', '统计分析')}
        </button>
        <button
          type="button"
          onClick={() => setSubTab('runs')}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            subTab === 'runs'
              ? 'bg-primary/10 text-primary'
              : 'text-text-secondary hover:text-text-primary hover:bg-muted'
          }`}
          data-testid="subtab-runs"
        >
          <History className="h-4 w-4" />
          {t('subtabs.runs', '统计任务')}
        </button>
      </div>

      {subTab === 'statistics' ? (
        <>
          {/* Filter bar */}
          <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
            <CalendarDays className="h-4 w-4 text-text-muted shrink-0" />
            <div className="flex items-center gap-2">
              <label className="text-sm text-text-secondary">
                {t('filter.start_date', 'From')}
              </label>
              <input
                type="date"
                value={filter.startDate}
                onChange={e => setStartDate(e.target.value)}
                className="rounded-md border border-border bg-base px-3 py-1.5 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30"
                data-testid="stats-filter-date-from"
              />
            </div>
            <span className="text-text-muted">—</span>
            <div className="flex items-center gap-2">
              <label className="text-sm text-text-secondary">{t('filter.end_date', 'To')}</label>
              <input
                type="date"
                value={filter.endDate}
                onChange={e => setEndDate(e.target.value)}
                className="rounded-md border border-border bg-base px-3 py-1.5 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30"
                data-testid="stats-filter-date-to"
              />
            </div>
          </div>

          {/* Dashboard first screen */}
          <DashboardSection scope="admin" filter={metricFilter} />

          {/* Quality alert panel: surfaces KBs needing attention */}
          <QualityAlertPanel filter={metricFilter} />

          <hr className="border-border" />

          {/* Domain-level metrics */}
          <StatsPage scope="admin" filter={metricFilter} hideDashboard />
        </>
      ) : (
        <StatRunsPanel />
      )}
    </div>
  )
}
