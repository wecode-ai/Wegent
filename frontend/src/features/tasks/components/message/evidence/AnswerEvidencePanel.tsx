// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Copy, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { copyMessageText } from '../copyMessageText'
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
      className="h-11 w-11 shrink-0 p-0"
      aria-label={t('evidence.close')}
      data-testid="answer-evidence-close"
      onClick={onClose}
    >
      <X className="h-5 w-5" aria-hidden />
    </Button>
  )
  const title = t(originalOpen ? 'evidence.current_original' : 'evidence.title')
  const changed = versionStatus === 'changed' && original !== undefined
  const returnToFragment = () => {
    focusFragment.current = true
    setOriginalFor(undefined)
  }
  const content = (
    <>
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        {mode === 'side' ? (
          <h2 id={titleId} className="font-semibold">
            {title}
          </h2>
        ) : (
          <DialogTitle className="text-base">{title}</DialogTitle>
        )}
        {close}
      </header>
      <div className="space-y-2 border-b border-border px-4 py-3">
        <h3 className="break-words font-medium">
          {t('evidence.citation_label', { title: entry.citation.title, number: entry.number })}
        </h3>
        {entries.length > 1 && (
          <select
            aria-label={t('evidence.select_fragment')}
            data-testid="answer-evidence-select-fragment"
            className="h-11 w-full rounded-lg border border-border bg-surface px-2 text-sm"
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
                {t('evidence.citation_label', { title: item.citation.title, number: item.number })}
              </option>
            ))}
          </select>
        )}
        {changed && <p className="text-sm font-medium">{t('evidence.original_changed')}</p>}
        {original && (
          <div className="flex flex-wrap items-center gap-2">
            {(changed || originalOpen) && (
              <Button
                ref={returnButton}
                type="button"
                variant="outline"
                className="min-h-11"
                aria-pressed={changed ? !originalOpen : undefined}
                disabled={changed && !originalOpen}
                data-testid="answer-evidence-return-fragment"
                onClick={returnToFragment}
              >
                {t(changed ? 'evidence.answer_fragment' : 'evidence.return_fragment')}
              </Button>
            )}
            {(changed || !originalOpen) && (
              <Button
                ref={openOriginalButton}
                type="button"
                variant="outline"
                className="min-h-11"
                aria-pressed={changed ? originalOpen : undefined}
                disabled={changed && originalOpen}
                data-testid="answer-evidence-open-original"
                onClick={() => {
                  fragmentPosition.current = scroll.current?.scrollTop ?? 0
                  setOriginalFor(original.selectionSignal)
                }}
              >
                {t(changed ? 'evidence.current_original' : 'evidence.open_original')}
              </Button>
            )}
            {!originalOpen && read.status === 'ready' && (
              <CopyExcerpt key={citationId} content={read.snapshot.content} />
            )}
          </div>
        )}
      </div>
      {originalOpen ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-4 py-3 text-sm">
          <CurrentEvidenceOriginal {...original} />
        </div>
      ) : (
        <div
          ref={scroll}
          role="region"
          aria-label={title}
          tabIndex={0}
          data-testid="answer-evidence-scroll"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
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
        className="flex h-full flex-col"
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

function CopyExcerpt({ content }: { content: string }) {
  const { t } = useTranslation('chat')
  const [copyResult, setCopyResult] = useState<'copied' | 'copy_failed'>()

  const copy = async (trigger: HTMLButtonElement) => {
    setCopyResult((await copyMessageText(content, trigger)) ? 'copied' : 'copy_failed')
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        type="button"
        className="min-h-11"
        data-testid="answer-evidence-copy-fragment"
        onClick={event => void copy(event.currentTarget)}
      >
        <Copy className="h-4 w-4" aria-hidden />
        {t('evidence.copy_fragment')}
      </Button>
      {copyResult && (
        <span role="status" className="text-sm">
          {t(`evidence.${copyResult}`)}
        </span>
      )}
    </div>
  )
}

registerTaskRightPanel(ANSWER_EVIDENCE_PANEL, AnswerEvidencePanel)
