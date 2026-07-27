// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'

// Types
export interface MetricFilter {
  start_date?: string
  end_date?: string
  namespaces?: string[]
  kb_ids?: number[]
  run_id?: number
}

export interface FieldSchema {
  key: string
  type: string
  label: string
}

export interface MetricResponse {
  metric_name: string
  run_id: number | null
  run_completed_at: string | null
  schema: FieldSchema[]
  rows: Record<string, unknown>[]
}

export interface MetricsBatchResponse {
  results: Record<string, MetricResponse>
}

export interface QualityAlertMetricsResponse extends MetricsBatchResponse {
  coverage: {
    complete: boolean
    incomplete_metrics: string[]
  }
}

export interface GlobalTotalsData {
  total_kb_count: number
  total_doc_count: number
  total_storage: number
  dingtalk_synced_user_count: number
  dingtalk_kb_count: number
  dingtalk_doc_count: number
}

export interface PeriodTotalsData {
  period_total_queries: number
  period_new_kb: number
  period_new_docs: number
  period_rag_queries: number
  period_direct_inject: number
  period_kb_head_queries: number
  active_kb_ratio: number | null
}

export interface DailyDashboardRow {
  stat_date: string | null
  total_queries: number
  rag_queries: number
  direct_injection: number
  kb_head_rag_queries: number
  kb_head_queries: number
  active_kb_count: number
  active_user_count: number
  new_kb_count: number
  new_doc_count: number
  dingtalk_active_user_count: number
}

export interface PlatformHealthDistributionRow {
  stat_date: string
  excellent: number
  good: number
  fair: number
  poor: number
  no_data: number
}

export interface PlatformQualityRow {
  stat_date: string
  zero_chunk_rate: number | null
  total_queries: number
}

export interface PlatformRateRow {
  stat_date: string
  rate: number | null
  total_queries: number
}

export interface DashboardResponse {
  report_period: {
    start: string
    end: string
    days: number
  }
  generated_at: string | null
  global_totals: GlobalTotalsData | null
  period_totals: PeriodTotalsData | null
  daily_rows: DailyDashboardRow[]
  // Platform-level aggregate time-series (admin dashboard only).
  platform_health_distribution?: PlatformHealthDistributionRow[]
  platform_retrieval_quality?: PlatformQualityRow[]
  platform_hit_rate?: PlatformRateRow[]
  platform_adoption_rate?: PlatformRateRow[]
  platform_dedup_rate?: PlatformRateRow[]
}

export interface MetricListResponse {
  domains: {
    domain: string
    label: string
    metrics: {
      name: string
      label: string
      chart_hint: string
      description: string
      row_limit?: number
      // null = static snapshot (time selector has no effect);
      // non-null = time-series (responds to date range).
      date_col?: string | null
    }[]
  }[]
}

export interface RunInfo {
  id: number
  started_at: string | null
  completed_at: string | null
  status: string
  target_date: string | null
  kb_filter: string | null
  triggered_by: string
  triggered_user_id: number | null
  metrics_count: number
  error_message: string | null
  stat_start: string | null
  stat_end: string | null
}

export interface RunListResponse {
  runs: RunInfo[]
  total: number
}

export interface CollectorRunInfo {
  id: number
  domain: string
  collector_name: string
  status: string
  started_at: string | null
  completed_at: string | null
  rows_written: number
  duration_ms: number
  error_message: string | null
}

export interface CollectorRunListResponse {
  run_id: number
  collectors: CollectorRunInfo[]
}

export interface TriggerRunRequest {
  target_date?: string
  kb_ids?: number[]
  domains?: string[]
  collector_names?: string[]
  triggered_by?: string
  triggered_user_id?: number
}

export interface TriggerRunResponse {
  celery_task_id: string
}

export interface HealthResponse {
  stat_db_ok: boolean
  worker_ok: boolean
  enabled: boolean
  prune_enabled: boolean
  latest_run_id: number | null
  latest_run_completed_at: string | null
  latest_run_status: string | null
  metrics_registered: number
}

export type StatScope = 'admin' | { kbId: number }

function getBaseUrl(scope: StatScope): string {
  if (scope === 'admin') {
    return '/admin/knowledge-stats'
  }
  return `/knowledge-bases/${scope.kbId}/stats`
}

export async function fetchDashboard(
  scope: StatScope,
  filter: MetricFilter
): Promise<DashboardResponse> {
  return apiClient.post(`/${getBaseUrl(scope)}/dashboard`, filter)
}

export async function fetchMetric(
  scope: StatScope,
  name: string,
  filter: MetricFilter
): Promise<MetricResponse> {
  return apiClient.post(`/${getBaseUrl(scope)}/metrics/${name}`, filter)
}

export async function fetchMetricsBatch(
  scope: StatScope,
  names: string[],
  filter: MetricFilter
): Promise<MetricsBatchResponse> {
  return apiClient.post(`/${getBaseUrl(scope)}/metrics/batch`, { ...filter, names })
}

export async function fetchQualityAlertMetrics(
  filter: MetricFilter
): Promise<QualityAlertMetricsResponse> {
  return apiClient.post('/admin/knowledge-stats/quality-alert-metrics', filter)
}

export async function fetchMetricList(scope: StatScope): Promise<MetricListResponse> {
  return apiClient.get(`/${getBaseUrl(scope)}/metrics/list`)
}

export async function fetchRuns(params?: {
  limit?: number
  offset?: number
  status?: string
  target_date_start?: string
  target_date_end?: string
}): Promise<RunListResponse> {
  const query = new URLSearchParams()
  if (params?.limit) query.set('limit', String(params.limit))
  if (params?.offset) query.set('offset', String(params.offset))
  if (params?.status) query.set('status', params.status)
  if (params?.target_date_start) query.set('target_date_start', params.target_date_start)
  if (params?.target_date_end) query.set('target_date_end', params.target_date_end)
  return apiClient.get(`/admin/knowledge-stats/runs?${query}`)
}

export async function fetchCollectorRuns(runId: number): Promise<CollectorRunListResponse> {
  return apiClient.get(`/admin/knowledge-stats/runs/${runId}/collectors`)
}

export async function retryRun(runId: number): Promise<TriggerRunResponse> {
  return apiClient.post(`/admin/knowledge-stats/runs/${runId}/retry`)
}

export async function triggerRun(payload: TriggerRunRequest): Promise<TriggerRunResponse> {
  return apiClient.post('/admin/knowledge-stats/runs/trigger', payload)
}
