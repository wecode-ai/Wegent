import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { useEscapeKey } from '@/hooks/useEscapeKey'
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
  const contentRef = useRef<HTMLDivElement | null>(null)
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
    setOpen(true)
  }

  useLayoutEffect(() => {
    if (!open) return
    const triggerRect = triggerRef.current?.getBoundingClientRect()
    const contentRect = contentRef.current?.getBoundingClientRect()
    if (!triggerRect || !contentRect) return
    const sidePanel = document.querySelector('[data-testid="right-workspace-panel"]')
    const sidePanelRect = sidePanel?.getBoundingClientRect()
    const rightBoundary =
      sidePanelRect && sidePanelRect.width > 1 ? sidePanelRect.left : window.innerWidth - 8
    let left = triggerRect.left
    if (left + contentRect.width > rightBoundary) {
      left = rightBoundary - contentRect.width
    }
    left = Math.max(8, left)
    let top = triggerRect.top - contentRect.height - 4
    if (top < 8) {
      top = triggerRect.bottom + 4
    }
    setPosition(previous =>
      previous.left === left && previous.top === top ? previous : { left, top }
    )
  }, [open, comments])

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
            contentRef={contentRef}
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
  contentRef,
  comments,
  position,
  testId,
  onPointerEnter,
  onPointerLeave,
}: {
  contentRef: React.RefObject<HTMLDivElement | null>
  comments: CodeCommentContext[]
  position: { left: number; top: number }
  testId: string
  onPointerEnter: () => void
  onPointerLeave: () => void
}) {
  return (
    <div
      ref={contentRef}
      data-testid={testId}
      className="fixed z-popover max-h-[min(360px,calc(100vh-16px))] w-fit min-w-[280px] max-w-[min(420px,calc(100vw-16px))] overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
      style={position}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="divide-y divide-border">
        {comments.map(comment => (
          <CodeCommentPreviewItem key={comment.id} comment={comment} />
        ))}
      </div>
    </div>
  )
}

function CodeCommentPreviewItem({ comment }: { comment: CodeCommentContext }) {
  const { t } = useTranslation('common')
  const target = comment.browserAnnotation?.target
  const adjustments = comment.adjustments ?? []
  const codeLabel = `${comment.fileName}:${comment.startLine === comment.endLine ? comment.startLine : `${comment.startLine}-${comment.endLine}`}`
  const targetText =
    target?.isSimpleText && target.text ? truncate(target.text, TARGET_TEXT_LIMIT) : ''

  return (
    <div className="px-2 py-1.5 text-sm text-text-primary">
      <div className="flex min-w-0 items-center gap-1.5 font-medium">
        {target ? (
          <>
            <span className="inline-flex shrink-0 items-center rounded-md border border-border bg-muted px-1.5 py-px font-mono text-xs font-medium leading-[14px] text-text-secondary">
              {target.tagName}
            </span>
            {targetText && (
              <span className="truncate text-text-primary" title={targetText}>
                {targetText}
              </span>
            )}
          </>
        ) : (
          <span className="truncate" title={codeLabel}>
            {codeLabel}
          </span>
        )}
      </div>
      {!target && (
        <PreviewLine
          label={t('workbench.code_comment_selected_text')}
          value={comment.selectedText}
        />
      )}
      {comment.comment && (
        <p className="mt-1 truncate text-xs leading-4 text-text-primary" title={comment.comment}>
          {truncate(comment.comment, COMMENT_TEXT_LIMIT)}
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
    <p className="mt-1 truncate text-xs leading-4 text-text-secondary" title={value}>
      <span className="text-text-tertiary">{label}: </span>
      {truncate(value, COMMENT_TEXT_LIMIT)}
    </p>
  )
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value
}
