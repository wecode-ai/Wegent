import { useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { createRuntimeTaskCloseGuardState } from './runtimeTaskCloseGuardState'

export function RuntimeTaskCloseGuard() {
  const { t } = useTranslation('common')
  const [state] = useState(createRuntimeTaskCloseGuardState)
  const { open, closing } = useSyncExternalStore(state.subscribe, state.getSnapshot)

  return (
    <RuntimeTaskCloseConfirmDialog
      open={open}
      closing={closing}
      title={t('workbench.close_to_tray_hint_title')}
      description={t('workbench.close_to_tray_hint_description')}
      quitLabel={t('workbench.close_to_tray_hint_quit_action')}
      backgroundLabel={t('workbench.close_to_tray_hint_background_action')}
      onDismiss={state.dismiss}
      onQuit={state.quit}
      onKeepInBackground={state.keepInBackground}
    />
  )
}

interface RuntimeTaskCloseConfirmDialogProps {
  open: boolean
  closing: boolean
  title: string
  description: string
  quitLabel: string
  backgroundLabel: string
  onDismiss: () => Promise<void>
  onQuit: () => Promise<void>
  onKeepInBackground: () => Promise<void>
}

function RuntimeTaskCloseConfirmDialog({
  open,
  closing,
  title,
  description,
  quitLabel,
  backgroundLabel,
  onDismiss,
  onQuit,
  onKeepInBackground,
}: RuntimeTaskCloseConfirmDialogProps) {
  useEscapeKey(() => {
    if (!closing) void onDismiss()
  }, open && !closing)

  if (!open) return null

  return createPortal(
    <div
      data-testid="runtime-task-close-confirm-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="runtime-task-close-confirm-title"
        className="w-full max-w-[420px] rounded-lg border border-border bg-base p-5 shadow-2xl"
      >
        <h2
          id="runtime-task-close-confirm-title"
          className="text-base font-semibold text-text-primary"
        >
          {title}
        </h2>
        <p className="mt-2 text-sm leading-[18px] text-text-secondary">{description}</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="runtime-task-close-cancel-button"
            disabled={closing}
            onClick={() => {
              void onQuit()
            }}
          >
            {quitLabel}
          </Button>
          <Button
            type="button"
            variant="primary"
            data-testid="runtime-task-close-confirm-button"
            disabled={closing}
            onClick={() => {
              void onKeepInBackground()
            }}
          >
            {backgroundLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
