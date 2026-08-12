import { FileCode2, MessageSquare, MessageSquarePlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { isBrowserAnnotationContext } from '@/lib/browser-annotation-context'
import type { CodeCommentContext } from '@/types/workspace-files'

interface CodeCommentPreviewProps {
  comments: CodeCommentContext[]
  testId: string
  children: ReactNode
}

const COMMENT_TEXT_LIMIT = 240
const TARGET_TEXT_LIMIT = 120
const VALUE_LIMIT = 80

export function CodeCommentPreview({ comments, testId, children }: CodeCommentPreviewProps) {
  const triggerRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8 })

  const clearCloseTimer = () => {
    if (closeTimerRef.current === null) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }

  const show = () => {
    clearCloseTimer()
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      setPosition({
        left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 428)),
        top: Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 120)),
      })
    }
    setOpen(true)
  }

  const scheduleClose = () => {
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false)
      closeTimerRef.current = null
    }, 120)
  }

  useEffect(
    () => () => {
      clearCloseTimer()
    },
    []
  )

  useEscapeKey(() => setOpen(false), open)

  return (
    <>
      <div
        ref={triggerRef}
        className="inline-flex"
        onPointerEnter={show}
        onPointerLeave={scheduleClose}
        onFocus={show}
        onBlur={scheduleClose}
      >
        {children}
      </div>
      {open &&
        createPortal(
          <CodeCommentPreviewContent
            comments={comments}
            position={position}
            testId={testId}
            onPointerEnter={clearCloseTimer}
            onPointerLeave={scheduleClose}
          />,
          document.body
        )}
    </>
  )
}

function CodeCommentPreviewContent({
  comments,
  position,
  testId,
  onPointerEnter,
  onPointerLeave,
}: {
  comments: CodeCommentContext[]
  position: { left: number; top: number }
  testId: string
  onPointerEnter: () => void
  onPointerLeave: () => void
}) {
  return (
    <div
      data-testid={testId}
      className="fixed z-popover max-h-[calc(100vh-16px)] w-[min(420px,calc(100vw-16px))] overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
      style={position}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {comments.map((comment, index) => (
        <CodeCommentPreviewItem key={comment.id} comment={comment} number={index + 1} />
      ))}
    </div>
  )
}

function CodeCommentPreviewItem({
  comment,
  number,
}: {
  comment: CodeCommentContext
  number: number
}) {
  const { t } = useTranslation('common')
  const browser = isBrowserAnnotationContext(comment)
  const target = comment.browserAnnotation?.target
  const adjustments = comment.adjustments ?? []
  const label = target
    ? `#${comment.browserAnnotation?.number ?? number} <${target.tagName}> ${truncate(target.text, TARGET_TEXT_LIMIT)}`
    : `${comment.fileName}:${comment.startLine === comment.endLine ? comment.startLine : `${comment.startLine}-${comment.endLine}`}`
  const hasAdjustmentsOnly = browser && !comment.comment && adjustments.length > 0

  return (
    <div className="rounded-lg px-2 py-1.5 text-sm text-text-primary">
      <div className="flex min-w-0 items-center gap-1.5 font-medium">
        {browser ? (
          hasAdjustmentsOnly ? (
            <MessageSquarePlus
              className="h-3.5 w-3.5 shrink-0 text-text-secondary"
              aria-hidden="true"
            />
          ) : (
            <MessageSquare
              className="h-3.5 w-3.5 shrink-0 text-text-secondary"
              aria-hidden="true"
            />
          )
        ) : (
          <FileCode2 className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
        )}
        <span className="truncate" title={label}>
          {label}
        </span>
      </div>
      {!target && (
        <PreviewLine
          label={t('workbench.code_comment_selected_text')}
          value={comment.selectedText}
        />
      )}
      {comment.comment && (
        <PreviewLine label={t('workbench.code_comment_preview_comment')} value={comment.comment} />
      )}
      {hasAdjustmentsOnly && (
        <p className="mt-1 text-xs font-medium leading-4 text-text-secondary">
          {t('workbench.browser_annotation_adjustments_count', {
            count: adjustments.length,
          })}
        </p>
      )}
      {adjustments.slice(0, 3).map(adjustment => (
        <PreviewLine
          key={`${comment.id}:${adjustment.property}`}
          label={t(`workbench.browser_annotation_adjustment_${adjustment.property}`)}
          value={`${truncate(adjustment.before, VALUE_LIMIT)} -> ${truncate(adjustment.after, VALUE_LIMIT)}`}
        />
      ))}
      {adjustments.length > 3 && (
        <p className="mt-1 text-xs leading-4 text-text-tertiary">
          {t('workbench.browser_annotation_more_adjustments', { count: adjustments.length - 3 })}
        </p>
      )}
    </div>
  )
}

function PreviewLine({ label, value }: { label: string; value: string }) {
  return (
    <p className="mt-1 break-words text-xs leading-4 text-text-secondary" title={value}>
      <span className="text-text-tertiary">{label}: </span>
      {truncate(value, COMMENT_TEXT_LIMIT)}
    </p>
  )
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value
}
