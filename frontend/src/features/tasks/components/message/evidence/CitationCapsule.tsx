// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useContext, useId, useLayoutEffect, useRef } from 'react'
import { FileText } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useTranslation } from '@/hooks/useTranslation'
import { AnswerEvidenceContext } from './AnswerEvidenceContext'
import { EvidenceReadBody } from './AnswerEvidencePanel'
import { ChatEvidenceContext } from './ChatEvidenceHost'
import type { EvidenceEntry } from './useEvidenceRead'

const HOVER_DELAY = 180

export function CitationCapsule({
  entry,
  inSummary = false,
}: {
  entry: EvidenceEntry
  inSummary?: boolean
}) {
  const interaction = useContext(AnswerEvidenceContext)
  const host = useContext(ChatEvidenceContext)
  const { t } = useTranslation('chat')
  const { citation, number } = entry
  const anchor = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pointerDown = useRef(false)
  const keyboardFocused = useRef(false)
  const keepClosedOnFocus = useRef(false)
  const latest = useRef(interaction)
  const previewId = useId()
  latest.current = interaction

  const read = interaction?.read
  const preview = read?.kind === 'preview' && read.anchorId === previewId ? read : undefined
  const selected =
    read?.kind === 'panel' && read.entry.citation.citation_id === citation.citation_id
  const label = t('evidence.citation_label', { title: citation.title, number })

  const cancelTimer = () => {
    clearTimeout(timer.current)
    timer.current = undefined
  }

  useLayoutEffect(() => {
    const trigger = anchor.current
    return () => {
      clearTimeout(timer.current)
      latest.current?.closePreview(trigger)
    }
  }, [citation.citation_id, interaction?.scope])

  const showPreview = () => {
    cancelTimer()
    if (anchor.current) latest.current?.openPreview(entry, anchor.current, previewId)
  }

  const focusAnchor = () => {
    keepClosedOnFocus.current = true
    anchor.current?.focus({ preventScroll: true })
    keepClosedOnFocus.current = false
  }
  const closePreview = (restoreFocus = false) => {
    cancelTimer()
    keyboardFocused.current = false
    interaction?.closePreview(anchor.current)
    if (restoreFocus) focusAnchor()
  }

  const scheduleClose = () => {
    cancelTimer()
    timer.current = setTimeout(() => {
      if (
        !(keyboardFocused.current && document.activeElement === anchor.current) &&
        !popover.current?.contains(document.activeElement)
      )
        closePreview()
    }, HOVER_DELAY)
  }

  return (
    <Popover
      open={Boolean(preview)}
      onOpenChange={open => {
        if (!open) closePreview()
      }}
    >
      <PopoverAnchor asChild>
        <button
          ref={anchor}
          type="button"
          data-testid={
            inSummary
              ? `answer-evidence-summary-citation-${citation.citation_id}`
              : `answer-citation-${citation.citation_id}`
          }
          aria-label={label}
          aria-haspopup="dialog"
          aria-describedby={preview?.status === 'ready' ? previewId : undefined}
          aria-expanded={Boolean(preview || selected)}
          className="mx-0.5 inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 align-middle text-xs text-text-secondary hover:border-primary hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary aria-expanded:border-primary aria-expanded:text-primary max-md:min-h-11 max-md:min-w-11"
          onPointerEnter={event => {
            if (host?.mobile || host?.hasPanel || event.pointerType !== 'mouse') return
            cancelTimer()
            timer.current = setTimeout(showPreview, HOVER_DELAY)
          }}
          onPointerLeave={() => {
            pointerDown.current = false
            scheduleClose()
          }}
          onPointerDown={() => {
            pointerDown.current = true
            cancelTimer()
          }}
          onPointerUp={() => {
            pointerDown.current = false
          }}
          onPointerCancel={() => {
            pointerDown.current = false
          }}
          onFocus={event => {
            if (
              !pointerDown.current &&
              !keepClosedOnFocus.current &&
              event.currentTarget.matches(':focus-visible') &&
              !interaction?.isRestoringFocus(event.currentTarget)
            ) {
              keyboardFocused.current = true
              showPreview()
            }
          }}
          onBlur={event => {
            if (popover.current?.contains(event.relatedTarget)) return
            closePreview()
          }}
          onKeyDown={event => {
            if (event.key === 'Escape' && (preview || timer.current !== undefined)) {
              event.preventDefault()
              event.stopPropagation()
              closePreview()
            }
            if (
              event.key === 'Tab' &&
              !event.shiftKey &&
              preview?.status === 'error' &&
              preview.failure.retryable
            ) {
              const retry = popover.current?.querySelector('button')
              if (retry) {
                event.preventDefault()
                retry.focus()
              }
            }
          }}
          onClick={event => {
            pointerDown.current = false
            cancelTimer()
            interaction?.openPanel(entry, event.currentTarget)
          }}
        >
          {!inSummary && (
            <>
              <FileText className="h-3 w-3 shrink-0" aria-hidden />
              <span className="max-w-28 truncate">{citation.title}</span>
            </>
          )}
          <span className="tabular-nums">{number}</span>
        </button>
      </PopoverAnchor>
      {preview && (
        <PopoverContent
          ref={popover}
          aria-label={label}
          align="start"
          data-testid="answer-evidence-preview"
          className="w-80 max-w-[calc(100vw-2rem)] space-y-2 break-words text-sm"
          collisionPadding={12}
          onPointerEnter={cancelTimer}
          onPointerLeave={scheduleClose}
          onOpenAutoFocus={event => event.preventDefault()}
          onCloseAutoFocus={event => event.preventDefault()}
          onEscapeKeyDown={event => {
            event.preventDefault()
            closePreview(Boolean(popover.current?.contains(document.activeElement)))
          }}
          onFocusOutside={event => {
            if (event.target === anchor.current) event.preventDefault()
          }}
          onKeyDown={event => {
            if (event.key === 'Tab') closePreview(true)
          }}
        >
          <p className="font-medium">{label}</p>
          <div id={previewId}>
            <EvidenceReadBody
              read={preview}
              preview
              onRetry={() => {
                focusAnchor()
                interaction?.retryPreview()
              }}
            />
          </div>
        </PopoverContent>
      )}
    </Popover>
  )
}
