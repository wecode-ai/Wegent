import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { RotateCcw } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { createReleaseRollbackSource } from './releaseRollbackSource'

export function ReleaseRollbackSettings({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation('common')
  const [source] = useState(createReleaseRollbackSource)
  const {
    previous,
    open,
    busy,
    error: errorCode,
  } = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const error = errorCode
    ? t(
        errorCode === 'load'
          ? 'workbench.app_update_rollback_load_failed'
          : 'workbench.app_update_rollback_failed'
      )
    : null

  return (
    <>
      {previous ? (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="about-rollback-button"
          disabled={disabled || busy}
          onClick={source.open}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs text-text-secondary hover:bg-muted disabled:opacity-50"
        >
          <RotateCcw className="h-4 w-4" />
          {t('workbench.app_update_rollback_action', { version: previous.version })}
        </ControlButton>
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
        focusCancel
        onClose={source.close}
        onConfirm={() => void source.confirm()}
      />
    </>
  )
}
