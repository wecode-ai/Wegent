// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared action thresholds for KB-stat metrics.
 *
 * The per-card action-hint bar reads thresholds from this single source.
 * Rate fields are all 0-100 percentages (unified in migration 010).
 */

export interface MetricThreshold {
  /** The metric name in _METRIC_SPECS. */
  metric: string
  /** Candidate row fields to read the value from (first hit wins). */
  fields: string[]
  /** Trigger threshold for a warning action hint. */
  warn: number
  /** Critical threshold for a critical action hint. */
  critical: number
  /** When true, lower values are worse (e.g. health_score, hit_rate). */
  lowerIsWorse: boolean
}

export const ALERT_THRESHOLDS: MetricThreshold[] = [
  {
    metric: 'doc_index_failure_rate',
    fields: ['failure_rate'],
    warn: 10,
    critical: 25,
    lowerIsWorse: false,
  },
  {
    metric: 'kb_zero_chunk_rate',
    fields: ['zero_chunk_rate'],
    warn: 30,
    critical: 50,
    lowerIsWorse: false,
  },
  {
    metric: 'kb_health_score',
    fields: ['health_score'],
    warn: 50,
    critical: 30,
    lowerIsWorse: true,
  },
  {
    metric: 'kb_thin_doc_rate',
    fields: ['thin_doc_rate'],
    warn: 50,
    critical: 70,
    lowerIsWorse: false,
  },
  {
    metric: 'kb_retrieval_hit_rate',
    fields: ['hit_rate'],
    warn: 70,
    critical: 50,
    lowerIsWorse: true,
  },
  {
    metric: 'answer_adoption_rate',
    fields: ['adoption_rate'],
    warn: 50,
    critical: 30,
    lowerIsWorse: true,
  },
  {
    metric: 'query_dedup_rate',
    fields: ['dedup_rate'],
    warn: 30,
    critical: 15,
    lowerIsWorse: true,
  },
  {
    metric: 'kb_low_score_rate',
    fields: ['low_score_rate'],
    warn: 20,
    critical: 40,
    lowerIsWorse: false,
  },
  {
    metric: 'kb_abandon_rate',
    fields: ['abandon_rate'],
    warn: 20,
    critical: 40,
    lowerIsWorse: false,
  },
  {
    metric: 'kb_content_freshness',
    fields: ['freshness_rate'],
    warn: 20,
    critical: 10,
    lowerIsWorse: true,
  },
]

/** Look up a threshold by metric name. */
export function getThreshold(metric: string): MetricThreshold | undefined {
  return ALERT_THRESHOLDS.find(t => t.metric === metric)
}

/** Check if a value crosses the warn threshold. */
export function isWarn(value: number, t: MetricThreshold): boolean {
  return t.lowerIsWorse ? value < t.warn : value > t.warn
}

/** Check if a value crosses the critical threshold. */
export function isCritical(value: number, t: MetricThreshold): boolean {
  return t.lowerIsWorse ? value < t.critical : value > t.critical
}

/**
 * Health-score tier definitions.
 *
 * The 85/70/50 cutoffs are the single source of truth for mapping a numeric
 * health score (0-100) to a label/color tier. Previously these were
 * hardcoded in HealthPillarFromRow, HealthDistributionChart and
 * HealthScoreTable independently — any change had to be replicated in three
 * places. Import HEALTH_TIERS + healthTierOf() instead.
 */
export interface HealthTier {
  key: 'excellent' | 'good' | 'fair' | 'poor' | 'no_data'
  /** Minimum score (inclusive) for this tier; no_data has no minimum. */
  min: number
  /** i18n label key under knowledge-stat. */
  labelKey: string
  /** Tailwind text/bg classes for badges. */
  cls: string
  /** Chart color hex. */
  color: string
}

export const HEALTH_TIERS: HealthTier[] = [
  {
    key: 'excellent',
    min: 85,
    labelKey: 'tier_excellent',
    cls: 'text-green-600 bg-green-50',
    color: '#10B981',
  },
  {
    key: 'good',
    min: 70,
    labelKey: 'tier_good',
    cls: 'text-yellow-600 bg-yellow-50',
    color: '#F59E0B',
  },
  {
    key: 'fair',
    min: 50,
    labelKey: 'tier_fair',
    cls: 'text-orange-600 bg-orange-50',
    color: '#F97316',
  },
  { key: 'poor', min: 0, labelKey: 'tier_poor', cls: 'text-red-600 bg-red-50', color: '#EF4444' },
]

const NO_DATA_TIER: HealthTier = {
  key: 'no_data',
  min: -1,
  labelKey: 'tier_no_data',
  cls: 'text-text-muted bg-muted',
  color: '#9CA3AF',
}

/** Resolve a numeric health score to its tier. Null/undefined → no_data. */
export function healthTierOf(score: number | null | undefined): HealthTier {
  if (score == null || typeof score !== 'number') return NO_DATA_TIER
  return HEALTH_TIERS.find(t => score >= t.min) ?? NO_DATA_TIER
}
