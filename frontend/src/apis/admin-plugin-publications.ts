// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

export type PluginPublicationStage =
  | 'submit_request'
  | 'automated_checks'
  | 'administrator_review'
  | 'code_review'
  | 'release'

export type PluginPublicationStatus =
  | 'uploading'
  | 'submitted'
  | 'automatic_checking'
  | 'automatic_check_failed'
  | 'awaiting_admin'
  | 'admin_review'
  | 'changes_requested'
  | 'admin_accepted'
  | 'materializing'
  | 'draft_mr_open'
  | 'ci_running'
  | 'code_changes_requested'
  | 'merge_ready'
  | 'merged'
  | 'publishing'
  | 'published'
  | 'publish_failed'
  | 'withdrawn'
  | 'closed'

export type PluginPublicationRiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical'

export type PluginPublicationCheckSeverity = 'info' | 'warning' | 'blocker'

export type PluginPublicationCheckStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'warning'
  | 'blocked'
  | 'failed'
  | 'not_run'

export interface PluginPublicationSubmitter {
  id: number
  userName: string
  email?: string | null
}

export interface AdminPluginPublicationRequestSummary {
  id: number
  pluginId: number
  pluginName: string
  pluginSlug: string
  requestedVersion: string
  submitter: PluginPublicationSubmitter
  currentRevision: number
  stage: PluginPublicationStage
  status: PluginPublicationStatus
  riskLevel: PluginPublicationRiskLevel
  blockerCount: number
  warningCount: number
  submittedAt: string
  updatedAt: string
  gitlabStatus?: string | null
  waitingDurationSeconds?: number
}

export interface AdminPluginPublicationRequestListResponse {
  items: AdminPluginPublicationRequestSummary[]
  total: number
  page: number
  limit: number
}

export interface PluginPublicationDeclaration {
  key: string
  label: string
  declared: boolean
  detected?: boolean | null
  confirmed?: boolean | null
  details?: string[]
}

export interface PluginPublicationRevision {
  id: number
  number: number
  requestedVersion: string
  snapshotSha256: string
  sourceTreeSha256?: string | null
  status: PluginPublicationStatus
  releaseNotes?: string | null
  testNotes?: string | null
  sourceUpdatedAt?: string | null
  createdAt: string
  declarations: PluginPublicationDeclaration[]
  manifest: Record<string, unknown>
  packageEntries: string[]
  packageEntryCount: number
  packageEntriesTruncated: boolean
  capabilities: string[]
}

export interface PluginPublicationCheck {
  id: number
  checkCode: string
  title: string
  severity: PluginPublicationCheckSeverity
  status: PluginPublicationCheckStatus
  summary?: string | null
  evidence: string[]
  jobUrl?: string | null
  acknowledgementRequired: boolean
  acknowledged: boolean
}

export interface PluginPublicationEvent {
  id: number
  eventType: string
  actorType: 'user' | 'admin' | 'gitlab' | 'pipeline' | 'release_service' | 'system'
  actorName?: string | null
  message: string
  requiredChanges?: string[]
  failureDetails?: PluginPublicationFailureDetail[]
  createdAt: string
}

export interface PluginPublicationFailureDetail {
  jobName: string
  stage?: string | null
  status: string
  reason?: string | null
  jobUrl?: string | null
}

export interface PluginPublicationGitLabState {
  projectUrl?: string | null
  sourceBranch?: string | null
  mergeRequestIid?: number | null
  mergeRequestUrl?: string | null
  mergeRequestStatus?: string | null
  pipelineId?: number | null
  pipelineUrl?: string | null
  pipelineStatus?: string | null
  commitSha?: string | null
}

export interface PluginPublicationActionEligibility {
  canReturn: boolean
  canAccept: boolean
  canReconcile: boolean
  blockedReasons: string[]
}

export interface AdminPluginPublicationRequestDetail extends AdminPluginPublicationRequestSummary {
  enterprisePluginId?: number | null
  revision: PluginPublicationRevision
  revisions: PluginPublicationRevision[]
  checks: PluginPublicationCheck[]
  events: PluginPublicationEvent[]
  gitlab: PluginPublicationGitLabState | null
  actionEligibility: PluginPublicationActionEligibility
}

export interface AdminPluginPublicationRequestFilters {
  page?: number
  limit?: number
  status?: PluginPublicationStatus | 'all'
  riskLevel?: PluginPublicationRiskLevel | 'all'
  submitter?: string
  query?: string
  submittedAfter?: string
  submittedBefore?: string
}

export interface ReturnPluginPublicationRequestPayload {
  currentRevision: number
  reason: string
  requiredChanges: string[]
}

export interface AcceptPluginPublicationRequestPayload {
  currentRevision: number
  acknowledgedWarningCodes: string[]
}

export interface ReconcilePluginPublicationRequestPayload {
  currentRevision: number
}

function mutationIdempotencyKey(
  operation: 'return' | 'accept' | 'reconcile',
  requestId: number,
  payload: object,
  operationAttemptId?: string
): string {
  const serialized = JSON.stringify(payload)
  let first = 2166136261
  let second = 2246822507
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ code, 3266489917)
  }
  const fingerprint = `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
    .toString(16)
    .padStart(8, '0')}${serialized.length.toString(16)}`
  const attemptSegment = operationAttemptId ? `-${operationAttemptId}` : ''
  return `plugin-publication-admin-${operation}-${requestId}${attemptSegment}-${fingerprint}`
}

function mutationOptions(
  operation: 'return' | 'accept' | 'reconcile',
  requestId: number,
  payload: object,
  operationAttemptId?: string
) {
  return {
    headers: {
      'Idempotency-Key': mutationIdempotencyKey(operation, requestId, payload, operationAttemptId),
    },
  }
}

function dateBoundary(value: string, endOfDay: boolean): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : value
}

function buildListQuery(filters: AdminPluginPublicationRequestFilters): string {
  const params = new URLSearchParams()
  params.set('page', String(filters.page ?? 1))
  params.set('limit', String(filters.limit ?? 20))

  if (filters.status && filters.status !== 'all') {
    params.set('status', filters.status)
  }
  if (filters.riskLevel && filters.riskLevel !== 'all') {
    params.set('riskLevel', filters.riskLevel)
  }
  if (filters.submitter?.trim()) {
    params.set('submitter', filters.submitter.trim())
  }
  if (filters.query?.trim()) {
    params.set('query', filters.query.trim())
  }
  if (filters.submittedAfter?.trim()) {
    params.set('submittedAfter', dateBoundary(filters.submittedAfter.trim(), false))
  }
  if (filters.submittedBefore?.trim()) {
    params.set('submittedBefore', dateBoundary(filters.submittedBefore.trim(), true))
  }

  return params.toString()
}

export const adminPluginPublicationApis = {
  async listPublicationRequests(
    filters: AdminPluginPublicationRequestFilters = {},
    signal?: AbortSignal
  ): Promise<AdminPluginPublicationRequestListResponse> {
    const query = buildListQuery(filters)
    return apiClient.get(`/admin/plugins/publication-requests?${query}`, { signal })
  },

  async getPublicationRequest(
    requestId: number,
    signal?: AbortSignal,
    revision?: number
  ): Promise<AdminPluginPublicationRequestDetail> {
    const query = revision === undefined ? '' : `?revision=${encodeURIComponent(String(revision))}`
    return apiClient.get(`/admin/plugins/publication-requests/${requestId}${query}`, { signal })
  },

  async returnPublicationRequest(
    requestId: number,
    payload: ReturnPluginPublicationRequestPayload
  ): Promise<AdminPluginPublicationRequestDetail> {
    return apiClient.post(
      `/admin/plugins/publication-requests/${requestId}/return`,
      payload,
      mutationOptions('return', requestId, payload)
    )
  },

  async acceptPublicationRequest(
    requestId: number,
    payload: AcceptPluginPublicationRequestPayload
  ): Promise<AdminPluginPublicationRequestDetail> {
    return apiClient.post(
      `/admin/plugins/publication-requests/${requestId}/accept`,
      payload,
      mutationOptions('accept', requestId, payload)
    )
  },

  async reconcilePublicationRequest(
    requestId: number,
    payload: ReconcilePluginPublicationRequestPayload,
    operationAttemptId: string
  ): Promise<AdminPluginPublicationRequestDetail> {
    return apiClient.post(
      `/admin/plugins/publication-requests/${requestId}/reconcile`,
      payload,
      mutationOptions('reconcile', requestId, payload, operationAttemptId)
    )
  },
}
