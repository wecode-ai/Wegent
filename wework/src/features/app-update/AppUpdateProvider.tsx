import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useAppVersion } from '@/hooks/useAppVersion'
import { useTranslation } from '@/hooks/useTranslation'
import { formatAppUpdateVersion } from './app-update-format'
import { AppUpdateContext, APP_UPDATE_SIMULATE_EVENT } from './app-update-context'
import { createAppUpdateSource } from './appUpdateSource'

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common')
  const appVersion = useAppVersion()
  const [source] = useState(createAppUpdateSource)
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe(listener, appVersion),
    [source, appVersion]
  )
  const { value, restartConfirmationOpen, retryUpdate } = useSyncExternalStore(
    subscribe,
    source.getSnapshot
  )
  const { availableUpdate, status } = value
  useDOMEvent('window', APP_UPDATE_SIMULATE_EVENT, source.simulateUpdate)

  return (
    <AppUpdateContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={restartConfirmationOpen || retryUpdate !== null}
        title={
          retryUpdate
            ? t('workbench.app_update_retry_confirm_title')
            : t('workbench.app_update_restart_confirm_title', '重启并更新 Wework？')
        }
        description={
          retryUpdate
            ? t(
                retryUpdate.retryConfirmation?.reason === 'startup-failed'
                  ? 'workbench.app_update_retry_startup_description'
                  : retryUpdate.retryConfirmation?.reason === 'rolled-back'
                    ? 'workbench.app_update_retry_rollback_description'
                    : 'workbench.app_update_retry_legacy_description',
                { version: retryUpdate.retryConfirmation?.version }
              )
            : formatAppUpdateVersion(
                t('workbench.app_update_restart_confirm_description', {
                  defaultValue:
                    '更新到 v{{version}} 需要关闭并重新打开 Wework。请先保存尚未完成的工作。',
                  version: availableUpdate?.version ?? '',
                }),
                availableUpdate?.version ?? ''
              )
        }
        cancelLabel={t('common.cancel', '取消')}
        confirmLabel={
          retryUpdate
            ? t('workbench.app_update_retry_confirm_action')
            : t('workbench.app_update_restart_confirm_action', '更新并重启')
        }
        confirmTestId={retryUpdate ? 'app-update-retry-confirm' : 'app-update-restart-confirm'}
        focusCancel={!retryUpdate}
        dialogTestId={retryUpdate ? 'app-update-retry-dialog' : undefined}
        cancelTestId={retryUpdate ? 'app-update-retry-cancel' : undefined}
        confirmDisabled={status === 'checking'}
        onClose={source.closeConfirmation}
        onConfirm={() => void source.confirm()}
      />
    </AppUpdateContext.Provider>
  )
}
