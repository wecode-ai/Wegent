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
