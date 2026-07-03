import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { destroyCurrentWindow, installRuntimeTaskCloseGuard } from '@/tauri/runtimeTaskCloseGuard'
import type { RuntimeWorkListResponse } from '@/types/api'

interface RuntimeTaskCloseGuardProps {
  runtimeWork: RuntimeWorkListResponse | null
}

export function RuntimeTaskCloseGuard({ runtimeWork }: RuntimeTaskCloseGuardProps) {
  const { t } = useTranslation('common')
  const runtimeWorkRef = useRef(runtimeWork)
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    runtimeWorkRef.current = runtimeWork
  }, [runtimeWork])

  useEffect(() => {
    if (!isTauriRuntime()) return undefined

    let unlisten: (() => void) | undefined
    let cancelled = false

    void installRuntimeTaskCloseGuard(
      () => runtimeWorkRef.current,
      () => {
        setCloseDialogOpen(true)
      }
    )
      .then(nextUnlisten => {
        if (cancelled) {
          nextUnlisten()
          return
        }
        unlisten = nextUnlisten
      })
      .catch(error => {
        console.error('Failed to install runtime task close guard:', error)
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  return (
    <RuntimeTaskCloseConfirmDialog
      open={closeDialogOpen}
      closing={closing}
      title={t('workbench.runtime_task_close_confirm_title')}
      description={t('workbench.runtime_task_close_confirm_description')}
      cancelLabel={t('workbench.cancel')}
      confirmLabel={t('workbench.runtime_task_close_confirm_action')}
      onCancel={() => {
        if (closing) return
        setCloseDialogOpen(false)
      }}
      onConfirm={async () => {
        setClosing(true)
        try {
          await destroyCurrentWindow()
        } catch (error) {
          console.error('Failed to close window after runtime task close confirmation:', error)
          setClosing(false)
        }
      }}
    />
  )
}

interface RuntimeTaskCloseConfirmDialogProps {
  open: boolean
  closing: boolean
  title: string
  description: string
  cancelLabel: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => Promise<void>
}

function RuntimeTaskCloseConfirmDialog({
  open,
  closing,
  title,
  description,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
}: RuntimeTaskCloseConfirmDialogProps) {
  useEscapeKey(() => {
    if (!closing) onCancel()
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
        <p className="mt-2 text-[13px] leading-[18px] text-text-secondary">{description}</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="runtime-task-close-cancel-button"
            disabled={closing}
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="primary"
            data-testid="runtime-task-close-confirm-button"
            disabled={closing}
            onClick={() => {
              void onConfirm()
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
