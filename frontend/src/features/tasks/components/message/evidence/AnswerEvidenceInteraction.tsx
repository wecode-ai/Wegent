// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { apiClient } from '@/apis/client'
import { useUser } from '@/features/common/UserContext'
import { useTranslation } from '@/hooks/useTranslation'
import { shouldHideAnswerMarker } from '../../../utils/answerEvidenceMarkers'
import { TaskRightPanelRenderer } from '../../right-panel'
import { ANSWER_EVIDENCE_PANEL, type AnswerEvidencePanelProps } from './AnswerEvidencePanel'
import { ChatEvidenceContext } from './ChatEvidenceHost'
import type { EvidenceScope } from './evidenceRead'
import { getDisplayedCitationIds } from './evidenceRemark'
import { AnswerEvidenceContext } from './AnswerEvidenceContext'
import { CitationCapsule } from './CitationCapsule'
import { useEvidenceRead, type EvidenceEntry } from './useEvidenceRead'

export function AnswerEvidenceInteraction({
  evidence,
  markdown,
  children,
}: {
  evidence?: EvidenceScope
  markdown: string | readonly string[]
  children: ReactNode
}) {
  const host = useContext(ChatEvidenceContext)
  const { user } = useUser()
  const enabled = Boolean(host && evidence?.committed && evidence.answerId && evidence.generationId)
  const citations = enabled ? evidence?.citations : undefined
  const entries = useMemo(() => {
    const result = new Map<string, EvidenceEntry>()
    if (!citations?.length) return result

    const indexed = new Map(citations.map(citation => [citation.citation_id, citation]))
    for (const id of getDisplayedCitationIds(markdown)) {
      const citation = indexed.get(id)
      if (citation) result.set(id, { citation, number: result.size + 1 })
    }
    return result
  }, [citations, markdown])
  if (!host || !evidence) return children

  const scope = JSON.stringify([
    user?.id,
    apiClient.getCacheScope(),
    host.taskKey,
    evidence.permissionScope,
    evidence.taskId,
    evidence.shared,
    evidence.answerId,
    evidence.generationId,
    evidence.committed,
    [...entries.values()],
  ])
  return (
    <ScopedAnswerEvidence scope={scope} host={host} evidence={evidence} entries={entries}>
      {children}
    </ScopedAnswerEvidence>
  )
}

function ScopedAnswerEvidence({
  host,
  scope,
  evidence,
  entries,
  children,
}: {
  host: NonNullable<React.ContextType<typeof ChatEvidenceContext>>
  scope: string
  evidence: EvidenceScope
  entries: ReadonlyMap<string, EvidenceEntry>
  children: ReactNode
}) {
  const { t } = useTranslation('chat')
  const {
    active,
    read: latestRead,
    invalidated,
    start,
    clear,
    rejectSnapshot,
  } = useEvidenceRead(evidence, scope)
  const { open, release, sideSlot, mobile, suspended, isPanelOpen } = host
  const hidePreview = mobile || suspended
  const read = hidePreview && latestRead?.kind === 'preview' ? undefined : latestRead
  const origin = useRef<{
    anchor: HTMLButtonElement
    summary?: HTMLElement | null
    answer: HTMLElement | null
  } | null>(null)
  const restoreOnClose = useRef(false)
  const restoringFocus = useRef<HTMLButtonElement | null>(null)

  const owner = useMemo(() => {
    const panel = {
      dismiss: () => {
        clear()
        release(panel)
      },
    }
    return panel
  }, [clear, release])
  useLayoutEffect(() => () => release(owner), [owner, release])
  const hasPanel = read?.kind === 'panel'
  useLayoutEffect(() => {
    if (!hasPanel) release(owner)
    if ((host.hasPanel || hidePreview) && latestRead?.kind === 'preview') clear()
  }, [clear, hasPanel, hidePreview, host.hasPanel, latestRead?.kind, owner, release])

  const restoreFocus = useCallback(() => {
    if (!restoreOnClose.current || isPanelOpen()) return
    restoreOnClose.current = false
    const previous = origin.current
    origin.current = null
    if (!previous) return
    restoringFocus.current = previous.anchor
    const insideCollapsedDetails = previous.anchor.closest('details:not([open])')
    for (const target of [
      insideCollapsedDetails ? null : previous.anchor,
      previous.summary,
      previous.answer,
    ]) {
      if (!target?.isConnected) continue
      target.focus({ preventScroll: true })
      if (document.activeElement === target) break
    }
    restoringFocus.current = null
  }, [isPanelOpen])

  useLayoutEffect(() => {
    if (!invalidated) return
    if (invalidated === 'scope') origin.current = null
    restoreOnClose.current = invalidated === 'access' && document.activeElement === document.body
    owner.dismiss()
    restoreFocus()
  }, [invalidated, owner, restoreFocus])

  const openPanel = (entry: EvidenceEntry, anchor: HTMLButtonElement) => {
    if (suspended || entries.get(entry.citation.citation_id) !== entry) return
    restoreOnClose.current = false
    origin.current = {
      anchor,
      summary: anchor.closest('details')?.querySelector(':scope > summary'),
      answer: anchor.closest('[data-message-content]'),
    }
    open(owner)
    void start({ entry, anchor, kind: 'panel' })
  }

  const openPreview = (entry: EvidenceEntry, anchor: HTMLButtonElement, anchorId: string) => {
    const currentEntry = entries.get(entry.citation.citation_id)
    if (
      currentEntry &&
      !hidePreview &&
      !isPanelOpen() &&
      active.current?.selection.kind !== 'panel'
    ) {
      void start({ entry: currentEntry, anchor, anchorId, kind: 'preview' })
    }
  }
  const closePreview = (anchor: HTMLButtonElement | null) => {
    const selection = active.current?.selection
    if (selection?.kind === 'preview' && selection.anchor === anchor) clear()
  }
  const retryPreview = () => {
    if (read?.kind === 'preview') void start(read, true)
  }

  const visible = [...entries.values()].filter(
    ({ citation }) =>
      !shouldHideAnswerMarker(citation.citation_id, evidence) &&
      !evidence.unavailableCitations?.has(citation.citation_id)
  )
  const documents = new Map<string, EvidenceEntry[]>()
  for (const entry of visible) {
    const key = `${entry.citation.knowledge_base_id}:${entry.citation.document_id}`
    if (!documents.has(key)) documents.set(key, [])
    documents.get(key)?.push(entry)
  }

  const closePanel = () => {
    restoreOnClose.current = true
    owner.dismiss()
    if (sideSlot) restoreFocus()
  }
  const props: AnswerEvidencePanelProps | undefined = hasPanel
    ? {
        read,
        versionStatus: 'unknown',
        original:
          read.status === 'ready' && active.current
            ? {
                citation: read.entry.citation,
                evidence,
                selectionSignal: active.current.controller.signal,
                onSnapshotRejected: error => rejectSnapshot(error, read),
                onSourceDenied: access => {
                  if (evidence.onSourceDenied) {
                    evidence.onSourceDenied(read.entry.citation.knowledge_base_id, access)
                  } else {
                    owner.dismiss()
                  }
                },
              }
            : undefined,
        entries: visible,
        mode: mobile ? 'mobile' : sideSlot ? 'side' : 'overlay',
        restoreFocus,
        onSelect: entry =>
          void start({
            entry,
            anchor: active.current?.selection.anchor ?? read.anchor,
            kind: 'panel',
          }),
        onRetry: () => void start(read, true),
      }
    : undefined
  const panel = props && (
    <TaskRightPanelRenderer
      request={{ panelType: ANSWER_EVIDENCE_PANEL, panelProps: props }}
      onClose={closePanel}
    />
  )

  return (
    <AnswerEvidenceContext.Provider
      value={{
        evidence,
        scope,
        entries,
        read,
        openPanel,
        openPreview,
        closePreview,
        retryPreview,
        isRestoringFocus: anchor => restoringFocus.current === anchor,
      }}
    >
      {children}
      {documents.size > 0 && (
        <details className="mt-2 text-xs text-text-secondary">
          <summary
            className="w-fit cursor-pointer py-2 max-md:min-h-11"
            data-testid="answer-evidence-summary"
          >
            {t('evidence.summary', { documents: documents.size, fragments: visible.length })}
          </summary>
          <ul className="space-y-1">
            {[...documents].map(([key, excerpts]) => (
              <li key={key} className="flex flex-wrap items-center gap-1">
                <span className="break-all">{excerpts[0].citation.title}</span>
                {excerpts.map(entry => (
                  <CitationCapsule key={entry.citation.citation_id} entry={entry} inSummary />
                ))}
              </li>
            ))}
          </ul>
        </details>
      )}
      {panel && (sideSlot ? createPortal(panel, sideSlot) : panel)}
    </AnswerEvidenceContext.Provider>
  )
}
