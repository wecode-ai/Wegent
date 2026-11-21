'use client'

import { useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { apiClient, ApiError } from '@/apis/client'
import { CurrentEvidenceOriginal } from './CurrentEvidenceOriginal'
import { EvidenceReadError } from './EvidenceReadError'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import { isCitationDenied, isSourceHidden } from './sourceAccess'
import { shouldHideAnswerMarker } from '../../../utils/answerEvidenceMarkers'
import { evidenceRemark } from './evidenceRemark'
import { CitationMarkup } from './CitationMarkup'
import { AnswerEvidenceContext } from './AnswerEvidenceContext'
import {
  type AnswerCitation,
  type EvidenceScope,
  type EvidenceSnapshot,
  type ReadFailure,
  getReadFailure,
  readEvidenceSnapshot,
} from './evidenceRead'

export type { AnswerCitation, EvidenceScope } from './evidenceRead'

export default function AnswerEvidenceMarkdown({
  evidence,
  ...props
}: ComponentProps<typeof EnhancedMarkdown> & { evidence?: EvidenceScope }) {
  const interaction = useContext(AnswerEvidenceContext)
  if (interaction) return <CitationMarkup {...props} />
  return <LegacyEvidenceMarkdown {...props} evidence={evidence} />
}

function LegacyEvidenceMarkdown({
  evidence,
  ...props
}: ComponentProps<typeof EnhancedMarkdown> & { evidence?: EvidenceScope }) {
  const { user } = useUser()
  const scopeKey = JSON.stringify([
    user?.id,
    apiClient.getCacheScope(),
    evidence?.taskId,
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
  const [snapshot, setSnapshot] = useState<EvidenceSnapshot | null>(null)
  const [error, setError] = useState<ReadFailure>()
  const [showOriginal, setShowOriginal] = useState(false)
  const [deniedSources, setDeniedSources] = useState<ReadonlySet<number>>(new Set())
  const [answerDenied, setAnswerDenied] = useState(false)
  const [missingCitations, setMissingCitations] = useState<ReadonlySet<string>>(new Set())
  const pendingRead = useRef<AbortController | null>(null)
  const sequence = useRef(0)
  const scope = apiClient.getCacheScope()
  const current = (request: number) =>
    sequence.current === request && apiClient.getCacheScope() === scope

  const isHidden = (citation: AnswerCitation) =>
    evidence?.visitOnly === true ||
    deniedSources.has(citation.knowledge_base_id) ||
    isSourceHidden(evidence?.sourceAccess?.[citation.knowledge_base_id])
  const isUnavailable = (id: string) =>
    missingCitations.has(id) || evidence?.unavailableCitations?.has(id) === true
  const opened = evidence?.citations?.find(citation => citation.citation_id === openedId)
  const hidden = opened !== undefined && (isHidden(opened) || isUnavailable(opened.citation_id))
  const close = () => {
    sequence.current++
    pendingRead.current?.abort()
    setOpenedId(undefined)
    setSnapshot(null)
    setShowOriginal(false)
  }

  useLayoutEffect(() => {
    if (hidden) close()
  }, [hidden])
  useLayoutEffect(
    () => () => {
      sequence.current++
      pendingRead.current?.abort()
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
      setShowOriginal(false)
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
    const controller = new AbortController()
    pendingRead.current = controller
    setOpenedId(citation.citation_id)
    setSnapshot(null)
    setError(undefined)
    setShowOriginal(false)
    try {
      const data = await readEvidenceSnapshot(evidence, citation, controller.signal)
      if (current(request)) setSnapshot(data)
    } catch (failure) {
      if (current(request)) rejectSnapshot(failure, citation)
    }
  }

  const [token] = useState(() => Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-'))
  const streaming = evidence?.streaming
  const remarkPlugins = useMemo(() => [() => evidenceRemark(token, streaming)], [token, streaming])
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
              (shouldHideAnswerMarker(citationId, evidence) || (citation && isHidden(citation)))
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
          aria-label={t(showOriginal ? 'evidence.current_original' : 'evidence.title')}
          data-testid="answer-evidence-panel"
          className="my-3 rounded-lg border border-border bg-surface p-4"
        >
          <div className="flex justify-between gap-3">
            <strong>{t(showOriginal ? 'evidence.current_original' : 'evidence.title')}</strong>
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
          ) : showOriginal && snapshot && evidence && pendingRead.current ? (
            <div className="flex min-h-0 flex-col gap-2">
              <button
                type="button"
                className="min-h-11"
                data-testid="answer-evidence-return-fragment"
                onClick={() => setShowOriginal(false)}
              >
                {t('evidence.return_fragment')}
              </button>
              <CurrentEvidenceOriginal
                citation={opened}
                evidence={evidence}
                selectionSignal={pendingRead.current.signal}
                onSnapshotRejected={failure => rejectSnapshot(failure, opened)}
                onSourceDenied={access => denySource(opened, access)}
              />
            </div>
          ) : snapshot ? (
            <>
              <p className="whitespace-pre-wrap" data-testid="answer-evidence-content">
                {snapshot.content}
              </p>
              <button
                type="button"
                className="min-h-11 min-w-11"
                data-testid="answer-evidence-open-original"
                onClick={() => setShowOriginal(true)}
              >
                {t('evidence.open_original')}
              </button>
            </>
          ) : (
            <p>{t('evidence.loading')}</p>
          )}
        </section>
      )}
    </>
  )
}
