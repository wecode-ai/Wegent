'use client'

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { apiClient, ApiError } from '@/apis/client'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import { getDocument, getDocumentProtection } from '@/apis/knowledge'
import { DocumentDetailDialog } from '@/features/knowledge/document/components/DocumentDetailDialog'
import type { KnowledgeDocument, DocumentProtection } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import { isCitationDenied, isSourceHidden, type SourceAccessMap } from './sourceAccess'
import {
  answerEvidenceMarker,
  mapEvidenceText,
  type MarkdownNode,
} from '../../../utils/answerEvidenceMarkers'

export interface AnswerCitation {
  citation_id: string
  title: string
  knowledge_base_id: number
  document_id: number
}

export interface EvidenceScope {
  taskId?: number
  workspaceId?: number
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
  visitOnly?: boolean
}

interface Snapshot {
  citation_id: string
  content: string
  title: string
  knowledge_base_id: number
  document_id: number
}

// Work on Markdown text nodes before raw HTML is parsed. Code and links are opaque.
export function evidenceRemark(token: string) {
  return (root: unknown) => {
    mapEvidenceText(root as MarkdownNode, node => {
      const value = node.value ?? ''
      const parts: MarkdownNode[] = []
      let start = 0
      for (const match of value.matchAll(answerEvidenceMarker)) {
        parts.push({ type: 'text', value: value.slice(start, match.index) })
        parts.push({
          type: 'text',
          value: '',
          data: {
            hName: 'answer-citation',
            hProperties: { citationId: match[1] || '', evidenceToken: token },
          },
        })
        start = match.index + match[0].length
      }
      if (!start) return [node]
      parts.push({ type: 'text', value: value.slice(start) })
      return parts
    })
  }
}

export default function AnswerEvidenceMarkdown({
  evidence,
  ...props
}: ComponentProps<typeof EnhancedMarkdown> & { evidence?: EvidenceScope }) {
  const { user } = useUser()
  const scopeKey = JSON.stringify([
    user?.id,
    apiClient.getCacheScope(),
    evidence?.taskId,
    evidence?.workspaceId,
    evidence?.shared,
    evidence?.permissionScope,
    evidence?.answerId,
    evidence?.generationId,
    evidence?.committed,
    evidence?.citations,
    evidence?.committed ? props.source : undefined,
  ])
  return <EvidenceContent key={scopeKey} {...props} evidence={evidence} />
}

function EvidenceContent({
  evidence,
  ...props
}: ComponentProps<typeof EnhancedMarkdown> & { evidence?: EvidenceScope }) {
  const { t } = useTranslation('chat')
  const [openedId, setOpenedId] = useState<string>()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<ReadFailure>()
  const [originalError, setOriginalError] = useState<ReadFailure>()
  const [original, setOriginal] = useState<{
    document: KnowledgeDocument
    protection: DocumentProtection
    request: number
    originalRequest: number
  } | null>(null)
  const [deniedSources, setDeniedSources] = useState<ReadonlySet<number>>(new Set())
  const [answerDenied, setAnswerDenied] = useState(false)
  const [missingCitations, setMissingCitations] = useState<ReadonlySet<string>>(new Set())
  const pendingRead = useRef<AbortController | null>(null)
  const pendingOriginal = useRef<AbortController | null>(null)
  const sequence = useRef(0)
  const originalSequence = useRef(0)
  const scope = apiClient.getCacheScope()
  const current = (request: number) =>
    sequence.current === request && apiClient.getCacheScope() === scope

  const isHidden = (citation: AnswerCitation) =>
    deniedSources.has(citation.knowledge_base_id) ||
    isSourceHidden(evidence?.sourceAccess?.[citation.knowledge_base_id])
  const isUnavailable = (id: string) =>
    missingCitations.has(id) || evidence?.unavailableCitations?.has(id) === true
  const opened = evidence?.citations?.find(citation => citation.citation_id === openedId)
  const hidden = opened !== undefined && (isHidden(opened) || isUnavailable(opened.citation_id))
  const close = () => {
    sequence.current++
    pendingRead.current?.abort()
    pendingOriginal.current?.abort()
    setOpenedId(undefined)
    setSnapshot(null)
    setOriginal(null)
  }

  useLayoutEffect(() => {
    if (hidden) close()
  }, [hidden])
  useLayoutEffect(
    () => () => {
      sequence.current++
      pendingRead.current?.abort()
      pendingOriginal.current?.abort()
    },
    []
  )

  const denyAnswer = () => {
    close()
    setAnswerDenied(true)
    evidence?.onAnswerDenied?.()
  }

  const denySource = (citation: AnswerCitation, access: 'denied' | 'visit-only' = 'denied') => {
    close()
    if (evidence?.onSourceDenied) evidence.onSourceDenied(citation.knowledge_base_id, access)
    else setDeniedSources(previous => new Set(previous).add(citation.knowledge_base_id))
  }

  const readSnapshot = (citation: AnswerCitation, signal: AbortSignal) =>
    apiClient.get<Snapshot>(
      `/knowledge-bases/citations/${citation.citation_id}?answer_id=${evidence?.answerId}&generation_id=${evidence?.generationId}`,
      { cache: 'no-store', signal, redirectOnUnauthorized: false }
    )

  const rejectSnapshot = (failure: unknown, citation: AnswerCitation) => {
    if (isCitationDenied(failure, 'answer') && !evidence?.shared) {
      denyAnswer()
    } else if (isCitationDenied(failure, 'source')) {
      denySource(citation)
    } else if (failure instanceof ApiError && (failure.status === 404 || failure.status === 409)) {
      close()
      if (evidence?.onCitationUnavailable) evidence.onCitationUnavailable(citation.citation_id)
      else setMissingCitations(previous => new Set(previous).add(citation.citation_id))
    } else {
      setSnapshot(null)
      setError(getReadFailure(failure, 'read_failed'))
    }
  }

  const open = async (citation: AnswerCitation) => {
    if (
      isHidden(citation) ||
      isUnavailable(citation.citation_id) ||
      answerDenied ||
      !evidence?.answerId ||
      !evidence.generationId
    )
      return
    const request = ++sequence.current
    pendingRead.current?.abort()
    pendingOriginal.current?.abort()
    const controller = new AbortController()
    pendingRead.current = controller
    setOpenedId(citation.citation_id)
    setSnapshot(null)
    setError(undefined)
    setOriginal(null)
    setOriginalError(undefined)
    try {
      const data = await readSnapshot(citation, controller.signal)
      if (current(request)) setSnapshot(data)
    } catch (failure) {
      if (current(request)) rejectSnapshot(failure, citation)
    }
  }

  const handleOriginalDenial = async (
    failure: unknown,
    citation: AnswerCitation,
    stillOpen: () => boolean
  ): Promise<boolean> => {
    if (!(failure instanceof ApiError)) return false
    if (failure.status === 403) {
      denySource(citation)
      return true
    }
    if (failure.status !== 404) return false

    // These endpoints also use 404 to conceal sources the viewer cannot read.
    try {
      const permission = await knowledgePermissionApi.getMyPermission(citation.knowledge_base_id, {
        answerId: evidence?.answerId,
        taskId: evidence?.taskId,
        citationId: citation.citation_id,
      })
      if (!stillOpen()) return true
      if (permission.source_access === 'denied' || permission.source_access === 'visit-only') {
        denySource(citation, permission.source_access)
        return true
      }
    } catch {
      // Without a fresh source decision the original stays unavailable.
    }
    return false
  }

  const openOriginal = async () => {
    if (!snapshot || !opened || hidden) return
    const request = sequence.current
    const originalRequest = ++originalSequence.current
    pendingOriginal.current?.abort()
    const controller = new AbortController()
    pendingOriginal.current = controller
    const stillOpen = () => current(request) && originalSequence.current === originalRequest
    setOriginalError(undefined)
    setOriginal(null)
    try {
      await readSnapshot(opened, controller.signal)
    } catch (failure) {
      if (!stillOpen()) return
      rejectSnapshot(failure, opened)
      return
    }
    if (!stillOpen()) return
    try {
      const document = await getDocument(snapshot.document_id, controller.signal)
      if (!stillOpen()) return
      if (document.kind_id !== snapshot.knowledge_base_id) throw new Error('Document moved')
      const protection = await getDocumentProtection(snapshot.knowledge_base_id, controller.signal)
      if (stillOpen()) setOriginal({ document, protection, request, originalRequest })
    } catch (failure) {
      if (!stillOpen()) return
      const denied = await handleOriginalDenial(failure, opened, stillOpen)
      if (!denied && stillOpen()) setOriginalError(getReadFailure(failure, 'original_failed'))
    }
  }

  const [token] = useState(() => Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-'))
  const remarkPlugins = useMemo(() => [() => evidenceRemark(token)], [token])
  if (answerDenied) return <p role="alert">{t('evidence.answer_denied')}</p>
  return (
    <>
      <EnhancedMarkdown
        {...props}
        remarkPlugins={remarkPlugins}
        components={{
          ...props.components,
          'answer-citation': ({
            citationId,
            evidenceToken,
          }: {
            citationId?: string
            evidenceToken?: string
          }) => {
            const citation = evidence?.citations?.find(item => item.citation_id === citationId)
            if (
              evidenceToken === token &&
              (evidence?.visitOnly || (citation && isHidden(citation)))
            ) {
              return null
            }
            return evidenceToken === token &&
              evidence?.committed &&
              evidence.answerId &&
              evidence.generationId &&
              citation &&
              !isUnavailable(citation.citation_id) ? (
              <button
                type="button"
                data-testid={`answer-citation-${citationId}`}
                className="mx-1 min-h-11 min-w-11 text-primary underline"
                onClick={() => void open(citation)}
              >
                {citation.title}
              </button>
            ) : (
              <span data-testid="answer-evidence-unavailable" className="text-text-muted">
                {t('evidence.unavailable')}
              </span>
            )
          },
        }}
      />
      {opened && !hidden && (
        <section
          role="dialog"
          aria-label={t('evidence.title')}
          data-testid="answer-evidence-panel"
          className="my-3 rounded-lg border border-border bg-surface p-4"
        >
          <div className="flex justify-between gap-3">
            <strong>{t('evidence.title')}</strong>
            <button
              type="button"
              className="min-h-11 min-w-11"
              data-testid="answer-evidence-close"
              onClick={close}
            >
              {t('evidence.close')}
            </button>
          </div>
          {error ? (
            <EvidenceReadError failure={error} onRetry={() => void open(opened)} />
          ) : snapshot ? (
            <>
              <p className="whitespace-pre-wrap" data-testid="answer-evidence-content">
                {snapshot.content}
              </p>
              <button
                type="button"
                className="min-h-11 min-w-11"
                data-testid="answer-evidence-open-original"
                onClick={() => void openOriginal()}
              >
                {t('evidence.open_original')}
              </button>
            </>
          ) : (
            <p>{t('evidence.loading')}</p>
          )}
          {originalError && (
            <EvidenceReadError failure={originalError} onRetry={() => void openOriginal()} />
          )}
        </section>
      )}
      {original && snapshot && opened && !hidden && (
        <DocumentDetailDialog
          open
          onOpenChange={value => {
            if (!value) {
              originalSequence.current++
              pendingOriginal.current?.abort()
              setOriginal(null)
            }
          }}
          document={original.document}
          onReadError={failure => {
            if (!(failure instanceof ApiError) || ![403, 404].includes(failure.status)) return
            const stillOpen = () =>
              current(original.request) && originalSequence.current === original.originalRequest
            if (!stillOpen()) return
            setOriginal(null)
            setOriginalError(getReadFailure(failure, 'original_failed'))
            void handleOriginalDenial(failure, opened, stillOpen)
          }}
          knowledgeBaseId={snapshot.knowledge_base_id}
          allowDownload={original.protection.original_download_allowed === true}
          watermarkText={original.protection.watermark_text}
        />
      )}
    </>
  )
}

type ReadFailure = {
  key: 'read_failed' | 'original_failed' | 'read_denied' | 'unavailable'
  retryable: boolean
}

function getReadFailure(error: unknown, key: 'read_failed' | 'original_failed'): ReadFailure {
  if (error instanceof ApiError) {
    if (error.status === 403) return { key: 'read_denied', retryable: false }
    if (error.status === 404 || error.status === 409)
      return { key: 'unavailable', retryable: false }
    return { key, retryable: error.status >= 500 }
  }
  return { key, retryable: true }
}

function EvidenceReadError({ failure, onRetry }: { failure: ReadFailure; onRetry: () => void }) {
  const { t } = useTranslation('chat')
  return (
    <div role="alert">
      <p>{t(`evidence.${failure.key}`)}</p>
      {failure.retryable && (
        <button
          type="button"
          className="min-h-11 min-w-11 text-primary underline"
          data-testid={`answer-evidence-retry-${failure.key}`}
          onClick={onRetry}
        >
          {t('evidence.retry')}
        </button>
      )}
    </div>
  )
}
