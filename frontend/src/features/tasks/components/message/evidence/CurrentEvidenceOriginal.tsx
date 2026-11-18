// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useLayoutEffect, useRef, useState } from 'react'
import type { AttachmentDownloadScope } from '@/apis/attachments'
import { getApiBaseUrl } from '@/lib/runtime-config'
import { apiClient, ApiError } from '@/apis/client'
import { getDocument, getDocumentProtection } from '@/apis/knowledge'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import { ReadOnlyDocumentPreview } from '@/features/knowledge/document/components/ReadOnlyDocumentPreview'
import { EvidenceReadError } from './EvidenceReadError'
import { useTranslation } from '@/hooks/useTranslation'
import type { DocumentProtection, KnowledgeDocument } from '@/types/knowledge'
import {
  getReadFailure,
  matchesCitation,
  readEvidenceSnapshot,
  type AnswerCitation,
  type EvidenceScope,
  type ReadFailure,
} from './evidenceRead'

type OriginalState =
  | { status: 'loading' }
  | { status: 'error'; failure: ReadFailure }
  | {
      status: 'ready'
      document: KnowledgeDocument
      protection: DocumentProtection
      isCurrent: () => boolean
      signal: AbortSignal
      attachment: AttachmentDownloadScope & { revoke: () => void }
    }

export interface CurrentEvidenceOriginalProps {
  citation: AnswerCitation
  evidence: EvidenceScope
  selectionSignal: AbortSignal
  onSnapshotRejected: (error: unknown) => void
  onSourceDenied: (access: 'denied' | 'visit-only') => void
}

export function CurrentEvidenceOriginal(props: CurrentEvidenceOriginalProps) {
  const { t } = useTranslation('chat')
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<OriginalState>({ status: 'loading' })
  const latest = useRef(props)
  latest.current = props
  const { selectionSignal } = props

  useLayoutEffect(() => {
    if (selectionSignal.aborted) return
    const { citation, evidence } = latest.current
    const controller = new AbortController()
    const attachmentController = new AbortController()
    const abort = () => {
      controller.abort()
      attachmentController.abort()
    }
    selectionSignal.addEventListener('abort', abort, { once: true })
    const { signal } = controller
    const cacheScope = apiClient.getCacheScope()
    const isCurrent = () => !signal.aborted && apiClient.getCacheScope() === cacheScope
    const attachment = {
      apiBaseUrl: getApiBaseUrl(),
      signal: attachmentController.signal,
      isCurrent: () => isCurrent() && !attachmentController.signal.aborted,
      revoke: () => attachmentController.abort(),
    }
    const fail = (error: unknown) => {
      if (isCurrent())
        setState({ status: 'error', failure: getReadFailure(error, 'original_failed') })
    }

    const load = async () => {
      try {
        const snapshot = await readEvidenceSnapshot(evidence, citation, signal)
        if (!isCurrent()) return
        if (!matchesCitation(snapshot, citation)) throw new ApiError('Citation unavailable', 404)
      } catch (error) {
        if (!isCurrent()) return
        if (error instanceof ApiError && [403, 404, 409].includes(error.status)) {
          latest.current.onSnapshotRejected(error)
        } else {
          fail(error)
        }
        return
      }

      try {
        const document = await getDocument(citation.document_id, signal)
        if (!isCurrent()) return
        if (
          document.id !== citation.document_id ||
          document.kind_id !== citation.knowledge_base_id
        ) {
          setState({ status: 'error', failure: { key: 'original_unavailable', retryable: false } })
          return
        }
        const protection = await getDocumentProtection(citation.knowledge_base_id, signal)
        if (isCurrent())
          setState({ status: 'ready', document, protection, isCurrent, signal, attachment })
      } catch (error) {
        if (!isCurrent()) return
        if (await confirmSourceDenial(error, latest, isCurrent, signal)) return
        fail(error)
      }
    }
    void load()
    return () => {
      selectionSignal.removeEventListener('abort', abort)
      abort()
    }
  }, [attempt, selectionSignal])

  if (state.status === 'loading') return <p role="status">{t('evidence.original_loading')}</p>
  if (state.status === 'error') {
    return (
      <EvidenceReadError
        failure={state.failure}
        onRetry={() => {
          setState({ status: 'loading' })
          setAttempt(value => value + 1)
        }}
      />
    )
  }
  if (!state.isCurrent()) return null

  const onReadError = async (error: unknown, surface: 'content' | 'page' | 'attachment') => {
    if (!state.isCurrent()) return
    if (
      surface === 'attachment' &&
      error instanceof ApiError &&
      error.status === 403 &&
      error.errorCode === 'DOCUMENT_DOWNLOAD_DISABLED'
    ) {
      state.attachment.revoke()
      setState(current =>
        current.status === 'ready' && current.attachment === state.attachment
          ? {
              ...current,
              protection: { ...current.protection, original_download_allowed: false },
            }
          : current
      )
      return
    }

    const failure = getReadFailure(error, 'original_failed')
    if (
      surface === 'content' ||
      (surface === 'page' &&
        (failure.key === 'original_denied' || failure.key === 'original_unavailable'))
    ) {
      setState({ status: 'error', failure })
    }
    await confirmSourceDenial(error, latest, state.isCurrent, state.signal)
  }

  return (
    <ReadOnlyDocumentPreview
      document={state.document}
      allowDownload={state.protection?.original_download_allowed === true}
      watermarkText={state.protection?.watermark_text}
      signal={state.signal}
      isCurrent={state.isCurrent}
      attachmentScope={state.attachment}
      onReadError={onReadError}
    />
  )
}

async function confirmSourceDenial(
  error: unknown,
  latest: { current: CurrentEvidenceOriginalProps },
  isCurrent: () => boolean,
  signal: AbortSignal
): Promise<boolean> {
  if (!(error instanceof ApiError) || ![403, 404].includes(error.status)) return false
  const { citation, evidence } = latest.current
  try {
    const permission = await knowledgePermissionApi.getMyPermission(citation.knowledge_base_id, {
      taskId: evidence.taskId,
      signal,
    })
    if (
      isCurrent() &&
      (permission.source_access === 'denied' || permission.source_access === 'visit-only')
    ) {
      latest.current.onSourceDenied(permission.source_access)
      return true
    }
  } catch {
    // An unconfirmed source denial affects only the original view.
  }
  return false
}
