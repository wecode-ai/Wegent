// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { apiClient, ApiError } from '@/apis/client'
import type { AnswerCitation } from '@wegent/chat-core'
import type { SourceAccessMap } from './sourceAccess'

export type { AnswerCitation } from '@wegent/chat-core'

export interface EvidenceScope {
  taskId?: number
  shared?: boolean
  permissionScope?: string
  sourceAccess?: SourceAccessMap
  onSourceDenied?: (id: number, result?: 'denied' | 'visit-only') => void
  onAnswerDenied?: () => void
  unavailableCitations?: ReadonlySet<string>
  onCitationUnavailable?: (id: string) => void
  answerId?: number
  generationId?: string
  citations?: AnswerCitation[]
  committed: boolean
  streaming?: boolean
  visitOnly?: boolean
}

export interface EvidenceSnapshot {
  citation_id: string
  content: string
  title: string
  knowledge_base_id: number
  document_id: number
}

export type EvidenceVersionStatus = 'same' | 'changed' | 'unknown'

export function matchesCitation(snapshot: EvidenceSnapshot, citation: AnswerCitation): boolean {
  return (
    snapshot.citation_id === citation.citation_id &&
    snapshot.document_id === citation.document_id &&
    snapshot.knowledge_base_id === citation.knowledge_base_id
  )
}

export type ReadFailure = {
  key:
    | 'read_failed'
    | 'read_denied'
    | 'unavailable'
    | 'original_failed'
    | 'original_denied'
    | 'original_unavailable'
  retryable: boolean
}

export function getReadFailure(
  error: unknown,
  key: 'read_failed' | 'original_failed'
): ReadFailure {
  if (error instanceof ApiError) {
    const original = key === 'original_failed'
    if (error.status === 403)
      return { key: original ? 'original_denied' : 'read_denied', retryable: false }
    if (error.status === 404 || error.status === 409)
      return { key: original ? 'original_unavailable' : 'unavailable', retryable: false }
    return { key, retryable: error.status >= 500 }
  }
  return { key, retryable: true }
}

export function readEvidenceSnapshot(
  evidence: EvidenceScope,
  citation: AnswerCitation,
  signal: AbortSignal
) {
  return apiClient.get<EvidenceSnapshot>(
    `/knowledge-bases/citations/${citation.citation_id}?answer_id=${evidence.answerId}&generation_id=${evidence.generationId}`,
    { cache: 'no-store', signal, redirectOnUnauthorized: false }
  )
}
