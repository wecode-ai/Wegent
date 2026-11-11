import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

interface TransientNoticeProps {
  message: string | null
  tone?: 'success' | 'error'
  onClear: () => void
  horizontalAnchorRef?: RefObject<HTMLElement | null>
  visible?: boolean
  action?: { label: string; testId: string; onClick: () => void; pending: boolean }
}

interface HorizontalPlacement {
  left: number
  maxWidth: number
}

const NOTICE_VIEWPORT_GUTTER = 16

export function TransientNotice({
  message,
  tone = 'success',
  onClear,
  horizontalAnchorRef,
  visible = true,
  action,
}: TransientNoticeProps) {
  const [horizontalPlacement, setHorizontalPlacement] = useState<HorizontalPlacement | null>(null)

  useEffect(() => {
    if (!message || action) return

    const timeout = window.setTimeout(onClear, 2200)
    return () => window.clearTimeout(timeout)
  }, [action, message, onClear])

  useLayoutEffect(() => {
    if (!message || !horizontalAnchorRef || !visible) return
    const anchor = horizontalAnchorRef.current
    if (!anchor) return

    const updatePlacement = () => {
      const rect = anchor.getBoundingClientRect()
      setHorizontalPlacement({
        left: rect.left + rect.width / 2,
        maxWidth: Math.max(0, rect.width - NOTICE_VIEWPORT_GUTTER * 2),
      })
    }
    updatePlacement()

    const resizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(updatePlacement) : null
    resizeObserver?.observe(anchor)
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [horizontalAnchorRef, message, visible])

  if (!message || !visible) {
    return null
  }

  const notice = (
    <div
      role="status"
      data-testid="transient-notice"
      data-embedded-browser-occlusion
      style={
        horizontalPlacement
          ? {
              left: horizontalPlacement.left,
              maxWidth: horizontalPlacement.maxWidth,
            }
          : undefined
      }
      className={cn(
        'fixed left-1/2 top-28 z-system max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border bg-surface px-4 py-3 text-sm shadow-[0_8px_28px_rgba(0,0,0,0.12)]',
        tone === 'success'
          ? 'border-success/20 text-text-primary wework:border-primary/20'
          : 'border-destructive/30 text-destructive wework:border-red-200 wework:text-red-700'
      )}
    >
      {message}
      {action && (
        <button
          type="button"
          data-testid={action.testId}
          disabled={action.pending}
          onClick={action.onClick}
          className="ml-3 min-h-11 min-w-11 underline disabled:opacity-50 md:min-h-7 md:min-w-7"
        >
          {action.label}
        </button>
      )}
    </div>
  )

  return horizontalAnchorRef ? createPortal(notice, document.body) : notice
}
