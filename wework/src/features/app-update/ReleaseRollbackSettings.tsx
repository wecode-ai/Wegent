import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { flushDesktopLocalStoragePersistence } from '@/desktop/localStoragePersistence'

export function ReleaseRollbackSettings({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation('common')
  const [previous, setPrevious] = useState<{ version: string; restoreRequired: boolean } | null>(
    null
  )
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!isElectronRuntime()) return
    let active = true
    void invokeDesktopHost<typeof previous>('appUpdate.previousRelease')
      .then(value => {
        if (active) setPrevious(value)
      })
      .catch(() => {
        if (active) setError(t('workbench.app_update_rollback_load_failed'))
      })
    return () => {
      active = false
    }
  }, [t])

  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => {
      void invokeDesktopHost<{ phase?: string }>('appUpdate.downloadProgress')
        .then(progress => {
          if (progress?.phase !== 'failed') return
          setError(t('workbench.app_update_rollback_failed'))
          setBusy(false)
        })
        .catch(() => undefined)
    }, 250)
    return () => window.clearInterval(timer)
  }, [busy, t])

  const rollback = async () => {
    setBusy(true)
    setError(null)
    try {
      await flushDesktopLocalStoragePersistence()
      await invokeDesktopHost('appUpdate.rollback', {
        restoreConfirmed: previous?.restoreRequired === true,
      })
    } catch {
      setError(t('workbench.app_update_rollback_failed'))
      setBusy(false)
    }
  }

  return (
    <>
      {previous ? (
        <button
          type="button"
          data-testid="about-rollback-button"
          disabled={disabled || busy}
          onClick={() => setOpen(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs text-text-secondary hover:bg-muted disabled:opacity-50"
        >
          <RotateCcw className="h-4 w-4" />
          {t('workbench.app_update_rollback_action', { version: previous.version })}
        </button>
      ) : null}
      {error ? (
        <span
          role="alert"
          data-testid="about-rollback-error"
          className="text-xs text-text-secondary"
        >
          {error}
        </span>
      ) : null}
      <ConfirmDialog
        open={open}
        title={t('workbench.app_update_rollback_title')}
        description={t(
          previous?.restoreRequired
            ? 'workbench.app_update_rollback_restore_description'
            : 'workbench.app_update_rollback_description',
          { version: previous?.version }
        )}
        confirmLabel={t('workbench.app_update_rollback_confirm')}
        cancelLabel={t('common.cancel')}
        confirmTestId="app-update-rollback-confirm"
        onClose={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false)
          void rollback()
        }}
      />
    </>
  )
}
