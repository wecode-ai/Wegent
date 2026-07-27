// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import {
  BarChart3,
  FileText,
  Search,
  Users,
  GitBranch,
  HardDrive,
  Brain,
  Activity,
  ShieldCheck,
} from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'
import type { MetricFilter, MetricListResponse, MetricResponse, StatScope } from '../api'
import { useMetricsBatch } from '../hooks/useMetricsBatch'
import { domainToType, METRIC_TYPE_META, type MetricType } from '../metric-groups'
import { MetricCard } from './MetricCard'

const DOMAIN_ICONS: Record<string, React.ElementType> = {
  kb_lifecycle: Activity,
  dashboard: BarChart3,
  deep_analysis: Brain,
  doc_management: FileText,
  collaboration: GitBranch,
  sys_ops: HardDrive,
  retrieval: Search,
  user_behavior: Users,
  prometheus: BarChart3,
  content_quality: ShieldCheck,
}

type MetricMeta = MetricListResponse['domains'][0]['metrics'][0]

interface DomainSectionProps {
  scope: StatScope
  domain: MetricListResponse['domains'][0]
  filter: MetricFilter
  /** Override the type chip (used by the KB-detail "group by type" layout,
   *  where a synthetic section spans multiple domains). */
  typeOverride?: MetricType
  /** Override the metrics shown (used to filter core vs demoted, or to
   *  merge a type group). Defaults to the domain's own metrics. */
  metricsOverride?: MetricMeta[]
  /** Override the title i18n key (synthetic type-group sections). */
  titleKeyOverride?: string
}

export function DomainSection({
  scope,
  domain,
  filter,
  typeOverride,
  metricsOverride,
  titleKeyOverride,
}: DomainSectionProps) {
  const { t } = useTranslation('knowledge-stat')
  const Icon = DOMAIN_ICONS[domain.domain] ?? BarChart3
  const metrics = metricsOverride ?? domain.metrics
  const type = typeOverride ?? domainToType(domain.domain)
  const typeMeta = METRIC_TYPE_META[type]

  // One batch request per domain collapses N per-card requests into 1.
  // The whole stat page then issues ~9 requests (one per domain) instead
  // of ~50 (one per metric card).
  const names = metrics.map(m => m.name)
  const { data: batch, loading, error } = useMetricsBatch(scope, names, filter)

  // Pre-resolve each metric's response so cards don't re-fetch individually.
  const metricData: Record<string, MetricResponse> = batch?.results ?? {}

  const titleKey = titleKeyOverride ?? `domains.${domain.domain}`
  const fallbackTitle = domain.label || domain.domain

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 pb-2 border-b border-border">
        <div className="flex items-center justify-center h-7 w-7 rounded-md bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <h2 className="text-base font-semibold text-text-primary">{t(titleKey, fallbackTitle)}</h2>
        <span
          className={`text-[10px] font-medium rounded px-1.5 py-0.5 ${typeMeta.chipClass}`}
          data-testid={`domain-type-${domain.domain}`}
        >
          {t(typeMeta.labelKey, typeMeta.bullet)}
        </span>
        <span className="text-xs text-text-muted">{metrics.length}</span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {metrics.map(metric => (
          <MetricCard
            key={metric.name}
            scope={scope}
            name={metric.name}
            label={metric.label}
            filter={filter}
            chartHint={metric.chart_hint}
            description={metric.description}
            rowLimit={metric.row_limit}
            dateCol={metric.date_col}
            data={metricData[metric.name]}
            batchLoading={loading}
            batchError={error}
            type={type}
          />
        ))}
      </div>
    </div>
  )
}
