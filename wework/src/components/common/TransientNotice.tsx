import { createToaster } from '@wegent/collaboration/controls/toaster'
import { useTranslation } from '@/hooks/useTranslation'
import { position } from '@ui-sdk/core'
import { Toast, ToastAction, ToastRegion, ToastTitle } from '@wegent/collaboration/controls/Toast'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'

interface TransientNoticeProps {
  message: string | null
  tone?: 'success' | 'error'
  onClear: () => void
  horizontalAnchorRef?: RefObject<HTMLElement | null>
  visible?: boolean
  action?: { label: string; testId: string; onClick: () => void; pending: boolean }
}

function ActiveNotice({
  message,
  tone,
  onClear,
  horizontalAnchorRef,
  action,
}: Omit<TransientNoticeProps, 'visible'>) {
  const { t } = useTranslation('common')
  const [toaster] = useState(createToaster)
  const region = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    const id = toaster(message ?? '', {
      type: tone,
      duration: action ? Infinity : 2200,
      action: action
        ? { label: action.label, onAction: action.onClick, dismiss: false }
        : undefined,
      onDismiss: () => {
        if (active) onClear()
      },
    })
    return () => {
      active = false
      toaster.dismiss(id)
    }
  }, [action, message, onClear, toaster, tone])

  useLayoutEffect(() => {
    if (!horizontalAnchorRef || !region.current) return
    return position(
      {
        getBoundingClientRect: () => {
          const rect = horizontalAnchorRef.current?.getBoundingClientRect()
          return new DOMRect(
            (rect?.left ?? 0) + 16,
            112,
            Math.max(0, (rect?.width ?? window.innerWidth) - 32),
            0
          )
        },
      },
      region.current,
      { side: 'bottom', sideOffset: 0, align: 'center', collisionPadding: 16 }
    )
  }, [horizontalAnchorRef])

  const notice = (
    <ToastRegion
      ref={region}
      toaster={toaster}
      aria-label={t('notifications.title')}
      side="top"
      align="center"
      shortcut={null}
      className={
        horizontalAnchorRef
          ? 'fixed z-system w-max max-w-[min(var(--anchor-width),calc(100vw-2rem))]'
          : 'fixed left-1/2 top-28 z-system w-max max-w-[calc(100vw-2rem)] -translate-x-1/2'
      }
    >
      {() => (
        <Toast data-testid="transient-notice" data-embedded-browser-occlusion>
          <ToastTitle className="min-w-0 [overflow-wrap:anywhere]" />
          {action && (
            <ToastAction
              data-testid={action.testId}
              disabled={action.pending}
              className="min-h-11 min-w-11 shrink-0 underline disabled:opacity-40 md:min-h-7 md:min-w-7"
            />
          )}
        </Toast>
      )}
    </ToastRegion>
  )
  return horizontalAnchorRef ? createPortal(notice, document.body) : notice
}

export function TransientNotice({ message, visible = true, ...props }: TransientNoticeProps) {
  return message && visible ? <ActiveNotice key={message} message={message} {...props} /> : null
}
