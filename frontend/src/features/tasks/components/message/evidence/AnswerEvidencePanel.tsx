// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, BookOpen, ChevronRight, FileText, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { registerTaskRightPanel, type TaskRightPanelComponentProps } from '../../right-panel'
import { type EvidenceEntry, type EvidenceRead } from './useEvidenceRead'

import {
  CurrentEvidenceOriginal,
  type CurrentEvidenceOriginalProps,
} from './CurrentEvidenceOriginal'
import { EvidenceReadError } from './EvidenceReadError'
import type { EvidenceVersionStatus } from './evidenceRead'

export const ANSWER_EVIDENCE_PANEL = 'answer-evidence'

export interface AnswerEvidencePanelProps {
  read: EvidenceRead
  original?: CurrentEvidenceOriginalProps
  versionStatus: EvidenceVersionStatus
  entries: EvidenceEntry[]
  mode: 'side' | 'overlay' | 'mobile'
  restoreFocus: () => void
  onSelect: (entry: EvidenceEntry) => void
  onRetry: () => void
}

export function EvidenceReadBody({
  read,
  onRetry,
  preview = false,
}: {
  read: EvidenceRead
  onRetry: () => void
  preview?: boolean
}) {
  const { t } = useTranslation('chat')
  if (read.status === 'loading') return <p role="status">{t('evidence.loading')}</p>
  if (read.status === 'error') return <EvidenceReadError failure={read.failure} onRetry={onRetry} />
  return (
    <p
      className={`whitespace-pre-wrap break-words ${preview ? 'line-clamp-4' : ''}`}
      data-testid={preview ? 'answer-evidence-preview-content' : 'answer-evidence-content'}
    >
      {read.snapshot.content}
    </p>
  )
}

export function AnswerEvidencePanel({
  panelProps: { read, original, versionStatus, entries, mode, restoreFocus, onSelect, onRetry },
  onClose,
}: TaskRightPanelComponentProps<AnswerEvidencePanelProps>) {
  const { t } = useTranslation('chat')
  const titleId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const openOriginalButton = useRef<HTMLButtonElement>(null)
  const returnButton = useRef<HTMLButtonElement>(null)
  const fragmentPosition = useRef(0)
  const focusFragment = useRef(false)
  const [originalFor, setOriginalFor] = useState<AbortSignal>()
  const originalOpen = original !== undefined && originalFor === original.selectionSignal
  const { entry } = read
  const citationId = entry.citation.citation_id

  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0
  }, [citationId, read.scope])
  useLayoutEffect(() => {
    if (originalOpen) {
      returnButton.current?.focus({ preventScroll: true })
    } else if (focusFragment.current) {
      focusFragment.current = false
      if (scroll.current) scroll.current.scrollTop = fragmentPosition.current
      openOriginalButton.current?.focus({ preventScroll: true })
    }
  }, [originalOpen])
  useLayoutEffect(() => {
    if (mode === 'side') closeButton.current?.focus({ preventScroll: true })
  }, [mode])

  const close = (
    <Button
      ref={closeButton}
      variant="ghost"
      type="button"
      className="h-11 w-11 shrink-0 p-0 text-text-muted md:h-8 md:w-8"
      aria-label={t('evidence.close')}
      data-testid="answer-evidence-close"
      onClick={onClose}
    >
      <X className="h-4 w-4" aria-hidden />
    </Button>
  )
  const title = (
    <>
      {!originalOpen && <BookOpen className="h-4 w-4 shrink-0" aria-hidden />}
      {t(originalOpen ? 'evidence.current_original' : 'evidence.panel_title')}
    </>
  )
  const changed = versionStatus === 'changed' && original !== undefined
  const openCurrentOriginal = () => {
    if (!original) return
    fragmentPosition.current = scroll.current?.scrollTop ?? 0
    setOriginalFor(original.selectionSignal)
  }
  const returnToFragment = () => {
    focusFragment.current = true
    setOriginalFor(undefined)
  }
  const content = (
    <>
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-1.5 sm:px-5">
        {mode === 'side' ? (
          <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold">
            {title}
          </h2>
        ) : (
          <DialogTitle className="flex items-center gap-2 text-sm">{title}</DialogTitle>
        )}
        {close}
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <FileText className="h-4 w-4" aria-hidden />
          </span>
          <h3 className="min-w-0 break-words text-sm font-semibold">{entry.citation.title}</h3>
        </div>
        {entries.length > 1 && (
          <select
            aria-label={t('evidence.select_fragment')}
            data-testid="answer-evidence-select-fragment"
            className="h-11 max-w-[45%] rounded-md border border-border bg-base px-2 text-xs text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary md:h-8"
            value={citationId}
            onChange={event => {
              const next = entries.find(item => item.citation.citation_id === event.target.value)
              if (next) onSelect(next)
            }}
          >
            {!entries.some(item => item.citation.citation_id === citationId) && (
              <option value={citationId}>{t('evidence.unavailable')}</option>
            )}
            {entries.map(item => (
              <option key={item.citation.citation_id} value={item.citation.citation_id}>
                {item.citation.document_id === entry.citation.document_id &&
                item.citation.knowledge_base_id === entry.citation.knowledge_base_id
                  ? t('evidence.fragment_number', { number: item.number })
                  : t('evidence.citation_label', {
                      title: item.citation.title,
                      number: item.number,
                    })}
              </option>
            ))}
          </select>
        )}
        {entries.length <= 1 && (
          <span className="text-xs text-text-muted">
            {t('evidence.fragment_number', { number: entry.number })}
          </span>
        )}
      </div>
      {original && changed && (
        <div className="shrink-0 space-y-2 border-b border-border bg-surface px-4 py-3 sm:px-5">
          <p className="text-xs font-medium">{t('evidence.original_changed')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              ref={returnButton}
              type="button"
              variant="outline"
              className="min-h-11"
              aria-pressed={!originalOpen}
              disabled={!originalOpen}
              data-testid="answer-evidence-return-fragment"
              onClick={returnToFragment}
            >
              {t('evidence.answer_fragment')}
            </Button>
            <Button
              ref={openOriginalButton}
              type="button"
              variant="outline"
              className="min-h-11"
              aria-pressed={originalOpen}
              disabled={originalOpen}
              data-testid="answer-evidence-open-original"
              onClick={openCurrentOriginal}
            >
              {t('evidence.current_original')}
            </Button>
          </div>
        </div>
      )}
      {originalOpen ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-4 py-3 text-sm sm:px-5">
          {!changed && (
            <Button
              ref={returnButton}
              type="button"
              variant="ghost"
              className="h-11 shrink-0 self-start px-2 text-xs text-primary md:h-8"
              data-testid="answer-evidence-return-fragment"
              onClick={returnToFragment}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              {t('evidence.return_fragment')}
            </Button>
          )}
          <CurrentEvidenceOriginal {...original} />
        </div>
      ) : (
        <div
          ref={scroll}
          role="region"
          aria-label={t('evidence.title')}
          tabIndex={0}
          data-testid="answer-evidence-scroll"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 text-sm leading-7 text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary sm:px-5"
        >
          <EvidenceReadBody
            read={read}
            onRetry={() => {
              scroll.current?.focus({ preventScroll: true })
              onRetry()
            }}
          />
        </div>
      )}
      {original && !originalOpen && !changed && (
        <footer className="shrink-0 border-t border-border px-3 py-1 sm:px-4">
          <Button
            ref={openOriginalButton}
            type="button"
            variant="ghost"
            className="h-11 w-full justify-start px-2 text-xs text-primary md:h-9"
            data-testid="answer-evidence-open-original"
            onClick={openCurrentOriginal}
          >
            <FileText className="h-4 w-4" aria-hidden />
            {t('evidence.open_original')}
            <ChevronRight className="ml-auto h-4 w-4" aria-hidden />
          </Button>
        </footer>
      )}
    </>
  )

  if (mode === 'side') {
    return (
      <section
        role="complementary"
        aria-labelledby={titleId}
        data-testid="answer-evidence-panel"
        data-layout={mode}
        data-version-status={versionStatus}
        className="flex h-full min-h-0 flex-col bg-base"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }}
      >
        {content}
      </section>
    )
  }

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        hideCloseButton
        aria-describedby={undefined}
        aria-modal="true"
        data-testid="answer-evidence-panel"
        data-layout={mode}
        data-version-status={versionStatus}
        overlayProps={{ className: 'z-[70] bg-black/40' }}
        className={
          mode === 'mobile'
            ? 'inset-0 z-[71] flex h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0'
            : 'inset-y-0 left-auto right-0 z-[71] flex h-dvh w-[min(100%,28rem)] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0'
        }
        onOpenAutoFocus={event => {
          event.preventDefault()
          closeButton.current?.focus({ preventScroll: true })
        }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          restoreFocus()
        }}
      >
        {content}
      </DialogContent>
    </Dialog>
  )
}

registerTaskRightPanel(ANSWER_EVIDENCE_PANEL, AnswerEvidencePanel)
