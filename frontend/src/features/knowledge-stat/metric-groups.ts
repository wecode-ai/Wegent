// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Metric grouping, type tagging and core/demoted classification for the
// kb-stat dashboards. Pure config — no React — so both StatsPage and
// KbStatView can share it. See tmp/kb-stat-final-implementation-v4.md
// §2 (core/demoted split), §3.3 (domain→type) and §4.3 (KB-detail type
// grouping).

export type MetricType = 'business' | 'ops' | 'tech'

export interface MetricTypeMeta {
  type: MetricType
  /** i18n key suffix under `metric_types`. */
  labelKey: string
  /** Tailwind classes for the small type chip. */
  chipClass: string
  /** Bullet glyph used in compact contexts. */
  bullet: string
}

export const METRIC_TYPE_META: Record<MetricType, MetricTypeMeta> = {
  business: {
    type: 'business',
    labelKey: 'metric_types.business',
    chipClass: 'text-blue-600 bg-blue-50',
    bullet: '🔵',
  },
  ops: {
    type: 'ops',
    labelKey: 'metric_types.ops',
    chipClass: 'text-amber-600 bg-amber-50',
    bullet: '🟠',
  },
  tech: {
    type: 'tech',
    labelKey: 'metric_types.tech',
    chipClass: 'text-purple-600 bg-purple-50',
    bullet: '🟣',
  },
}

// Domain → type mapping (v4 §3.3). Used both for the type chip next to a
// domain title and for the KB-detail "group by type" layout (v4 §4.3).
export const DOMAIN_TO_TYPE: Record<string, MetricType> = {
  dashboard: 'business',
  kb_lifecycle: 'business',
  user_behavior: 'business',
  retrieval: 'tech',
  sys_ops: 'tech',
  prometheus: 'tech',
  doc_management: 'ops',
  content_quality: 'ops',
  deep_analysis: 'ops',
  collaboration: 'ops',
}

export function domainToType(domain: string): MetricType {
  return DOMAIN_TO_TYPE[domain] ?? 'ops'
}

// Ordered type groups for the KB-detail "group by type" layout (v4 §4.3).
export const TYPE_GROUP_ORDER: MetricType[] = ['tech', 'ops', 'business']

export const TYPE_GROUP_LABEL_KEY: Record<MetricType, string> = {
  tech: 'type_groups.tech',
  ops: 'type_groups.ops',
  business: 'type_groups.business',
}
