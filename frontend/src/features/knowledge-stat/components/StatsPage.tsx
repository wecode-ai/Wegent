// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo } from 'react'

import { useTranslation } from '@/hooks/useTranslation'
import { type MetricFilter, type MetricListResponse, type StatScope } from '../api'
import { useMetricList } from '../hooks/useMetricList'
import { DomainSection } from './DomainSection'
import {
  domainToType,
  METRIC_TYPE_META,
  TYPE_GROUP_LABEL_KEY,
  TYPE_GROUP_ORDER,
  type MetricType,
} from '../metric-groups'

interface StatsPageProps {
  scope: StatScope
  filter: MetricFilter
  hideDashboard?: boolean
  /** Group sections by metric type (🔵/🟠/🟣) instead of by domain.
   *  Used by the KB-detail page (v4 §4.3). */
  groupByType?: boolean
}

type MetricMeta = MetricListResponse['domains'][0]['metrics'][0]

interface Section {
  key: string
  /** Synthetic domain object passed to DomainSection. Its `domain` field
   *  drives the icon; `label` is the fallback title. */
  domain: MetricListResponse['domains'][0]
  typeOverride?: MetricType
  titleKeyOverride?: string
  metrics: MetricMeta[]
}

export function StatsPage({ scope, filter, hideDashboard, groupByType }: StatsPageProps) {
  const { t } = useTranslation('knowledge-stat')
  const { data, loading, error } = useMetricList(scope)

  // The metric list is already tier-filtered server-side (basic mode returns
  // only basic metrics), so every metric here is meant to be shown. There is
  // no longer a core/demoted split or a collapsed "advanced view" — all
  // returned metrics render directly, grouped by domain (or by type on the
  // KB-detail page).
  //
  // IMPORTANT: this useMemo MUST be called unconditionally (before any
  // early returns) to satisfy React's rules-of-hooks. When data is null
  // (loading), the memo computes on an empty array — harmless no-op.
  const domains = data
    ? hideDashboard
      ? data.domains.filter(d => d.domain !== 'dashboard')
      : data.domains
    : []

  const sections = useMemo(
    () => buildSections(domains, !!groupByType),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [domains, groupByType]
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-text-muted">
        {t('loading', 'Loading...')}
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center py-20 text-red-500">
        {error?.message || t('no_data', 'No data available')}
      </div>
    )
  }

  return (
    <div className="space-y-8" data-testid="kb-stats-page">
      {sections.map(section => (
        <DomainSection
          key={section.key}
          scope={scope}
          domain={section.domain}
          filter={filter}
          metricsOverride={section.metrics}
          typeOverride={section.typeOverride}
          titleKeyOverride={section.titleKeyOverride}
        />
      ))}
    </div>
  )

  function buildSections(domains: MetricListResponse['domains'], byType: boolean): Section[] {
    if (!byType) {
      const out: Section[] = []
      for (const d of domains) {
        if (d.metrics.length === 0) continue
        out.push({ key: d.domain, domain: d, metrics: d.metrics })
      }
      return out
    }

    // Group by metric type (v4 §4.3). Merge every domain's metrics into
    // one synthetic section per type.
    const byGroup: Record<MetricType, MetricMeta[]> = {
      tech: [],
      ops: [],
      business: [],
    }
    for (const d of domains) {
      const type = domainToType(d.domain)
      for (const m of d.metrics) {
        byGroup[type].push(m)
      }
    }
    const out: Section[] = []
    for (const type of TYPE_GROUP_ORDER) {
      const metrics = byGroup[type]
      if (metrics.length === 0) continue
      out.push({
        key: `__type_${type}`,
        domain: {
          domain: type,
          label: t(TYPE_GROUP_LABEL_KEY[type], METRIC_TYPE_META[type].bullet),
          metrics: [],
        },
        typeOverride: type,
        titleKeyOverride: TYPE_GROUP_LABEL_KEY[type],
        metrics,
      })
    }
    return out
  }
}
