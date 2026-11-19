import { useTranslation } from '@/hooks/useTranslation'
import { Toast, ToastAction, ToastRegion, ToastTitle } from '@wegent/collaboration/controls/Toast'
import { createToaster } from '@wegent/collaboration/controls/toaster'
import { useElementGeometry } from '@wegent/collaboration/dom-events'
import { useCallback, useMemo, useState, useSyncExternalStore, type RefObject } from 'react'
import { createPortal } from 'react-dom'

const idleSnapshot = () => null

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

  const subscribe = useCallback(() => {
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

  useSyncExternalStore(subscribe, idleSnapshot, idleSnapshot)
  const targets = useMemo(
    () => (horizontalAnchorRef ? [horizontalAnchorRef] : []),
    [horizontalAnchorRef]
  )
  const anchor = useElementGeometry(targets, Boolean(horizontalAnchorRef))?.elements[0]

  const notice = (
    <ToastRegion
      toaster={toaster}
      style={
        anchor
          ? { left: anchor.left + anchor.width / 2, maxWidth: Math.max(0, anchor.width - 32) }
          : undefined
      }
      aria-label={t('notifications.title')}
      side="top"
      align="center"
      shortcut={null}
      className="top-28 z-system w-max max-w-[calc(100vw-2rem)]"
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
