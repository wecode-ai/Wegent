// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared alert/action thresholds for KB-stat metrics.
 *
 * Both QualityAlertPanel.tsx (admin alert panel) and action-hints.ts
 * (per-card hint bar) read from this single source so they never disagree.
 * Rate fields are all 0-100 percentages (unified in migration 010).
 */

export interface MetricThreshold {
  /** The metric name in _METRIC_SPECS. */
  metric: string
  /** Candidate row fields to read the value from (first hit wins). */
  fields: string[]
  /** Trigger threshold (warn in action-hints, medium in alert panel). */
  warn: number
  /** Critical threshold (critical in action-hints, high in alert panel). */
  critical: number
  /** When true, lower values are worse (e.g. health_score, hit_rate). */
  lowerIsWorse: boolean
  /** Special handling for count-based metrics (e.g. orphan_doc_alert). */
  isCount?: boolean
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
    metric: 'thin_doc_alert',
    fields: ['thin_doc_rate'],
    warn: 50,
    critical: 70,
    lowerIsWorse: false,
  },
  {
    metric: 'orphan_doc_alert',
    fields: ['_count_'], // special: client-side count per KB
    warn: 100,
    critical: 300,
    lowerIsWorse: false,
    isCount: true,
  },
  // Additional thresholds for action-hints only (not in alert panel):
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
