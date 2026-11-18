import { useMemo, useSyncExternalStore, type RefObject } from 'react'
import { useElementGeometry } from '@wegent/collaboration/dom-events'
import { createTransientNoticeExpiration } from './transientNoticeExpiration'
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

const NOTICE_VIEWPORT_GUTTER = 16

export function TransientNotice({
  message,
  tone = 'success',
  onClear,
  horizontalAnchorRef,
  visible = true,
  action,
}: TransientNoticeProps) {
  const interactive = Boolean(action)
  const expiration = useMemo(
    () => createTransientNoticeExpiration(message, onClear, interactive),
    [message, onClear, interactive]
  )
  const expired = useSyncExternalStore(
    expiration.subscribe,
    expiration.getSnapshot,
    expiration.getSnapshot
  )
  const targets = useMemo(
    () => (horizontalAnchorRef ? [horizontalAnchorRef] : []),
    [horizontalAnchorRef]
  )
  const geometry = useElementGeometry(
    targets,
    Boolean(message && visible && !expired && horizontalAnchorRef)
  )
  const anchor = geometry?.elements[0]
  const horizontalPlacement = anchor
    ? {
        left: anchor.left + anchor.width / 2,
        maxWidth: Math.max(0, anchor.width - NOTICE_VIEWPORT_GUTTER * 2),
      }
    : null
  if (!message || !visible || expired) return null

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
