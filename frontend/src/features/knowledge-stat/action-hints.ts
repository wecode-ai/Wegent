// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Action-hint engine for metric cards (v4 §2/appendix A). Each rule reads
// the latest row of a metric, applies a threshold, and returns a hint the
// MetricCard renders above the chart. Thresholds are defined in the shared
// thresholds.ts so the hint bar and QualityAlertPanel never disagree.

import type { MetricResponse } from './api'
import { getThreshold, isWarn, isCritical } from './thresholds'

export type ActionHintLevel = 'info' | 'warn' | 'critical'

export interface ActionHint {
  level: ActionHintLevel
  /** i18n key under `action_hints`. */
  textKey: string
  /** Optional interpolation params for the i18n string. */
  params?: Record<string, string | number>
}

// i18n key mapping per metric (thresholds come from thresholds.ts).
// Note: kb_low_score_rate and query_dedup_rate are intentionally excluded
// from action hints — their thresholds are too context-dependent to give
// universal advice ("change embedding model" / "add FAQ" may not apply).
const HINT_TEXT_KEYS: Record<string, string> = {
  kb_zero_chunk_rate: 'action_hints.kb_zero_chunk_rate',
  kb_retrieval_hit_rate: 'action_hints.kb_retrieval_hit_rate',
  answer_adoption_rate: 'action_hints.answer_adoption_rate',
  kb_health_score: 'action_hints.kb_health_score',
  thin_doc_alert: 'action_hints.thin_doc_alert',
  doc_index_failure_rate: 'action_hints.doc_index_failure_rate',
  kb_abandon_rate: 'action_hints.kb_abandon_rate',
  kb_content_freshness: 'action_hints.kb_content_freshness',
}

/** Pick the latest row by stat_date/target_date (falling back to the last
 *  row for snapshot metrics). */
function latestRow(rows: Record<string, unknown>[]): Record<string, unknown> | null {
  if (rows.length === 0) return null
  let best: Record<string, unknown> | null = null
  let bestKey = ''
  for (const row of rows) {
    const key = String(row.stat_date ?? row.target_date ?? '')
    if (key && key >= bestKey) {
      bestKey = key
      best = row
    }
  }
  return best ?? rows[rows.length - 1]
}

function readNumber(row: Record<string, unknown>, fields: string[]): number | null {
  for (const f of fields) {
    const v = row[f]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

/** Compute the action hint for a metric response. Returns null when no
 *  rule applies or the threshold is not crossed. */
export function getActionHint(
  metricName: string,
  response: MetricResponse | undefined
): ActionHint | null {
  if (!response?.rows?.length) return null
  const t = getThreshold(metricName)
  if (!t || t.isCount) return null // count-based metrics handled by alert panel only

  const row = latestRow(response.rows)
  if (!row) return null
  const value = readNumber(row, t.fields)
  if (value === null) return null

  const textKey = HINT_TEXT_KEYS[metricName]
  if (!textKey) return null

  const params = { value: Number(value.toFixed(2)) }
  if (isCritical(value, t)) {
    return { level: 'critical', textKey, params }
  }
  if (isWarn(value, t)) {
    return { level: 'warn', textKey, params }
  }
  return null
}

export const ACTION_HINT_LEVEL_CLASS: Record<ActionHintLevel, string> = {
  info: 'bg-blue-50 text-blue-700 border-blue-200',
  warn: 'bg-amber-50 text-amber-700 border-amber-200',
  critical: 'bg-red-50 text-red-700 border-red-200',
}
