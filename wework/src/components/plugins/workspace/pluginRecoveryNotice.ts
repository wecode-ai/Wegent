import {
  clearDeferredPluginRecoveries,
  deferredPluginRecoveryIds,
  pendingPluginRecoveryId,
  PLUGIN_LOCAL_RECOVERY_OUTCOMES,
  type PluginOperationPhase,
  type PluginRecoveryOutcomesEvent,
} from '@/features/plugins/pluginLocalSync'
import { getErrorMessage } from '@/lib/error-message'
import type { PluginOperationNoticeState } from '../PluginOperationNotice'

/** Recovery receipts and progress belong to the catalog's actual visible notice. */
export function createPluginRecoveryNotice(input: {
  scopeKey(): string
  readNotice(): PluginOperationNoticeState | null
  showNotice(notice: PluginOperationNoticeState | null): void
  t(key: string): string
}) {
  let reply: PluginRecoveryOutcomesEvent | undefined
  const reconcile = () => {
    if (reply?.scopeKey !== input.scopeKey()) return
    const notice = input.readNotice()
    const { outcomes } = reply
    const deferred = new Set(deferredPluginRecoveryIds())
    const outcome = notice
      ? outcomes.find(item => notice.id === `plugin-recovery-${item.progressId}`)
      : outcomes.find(item => item.status !== 'reconciled' && deferred.has(item.progressId))
    clearDeferredPluginRecoveries(
      new Set(
        outcomes
          .filter(
            item =>
              item.status === 'reconciled' ||
              notice?.id === `plugin-recovery-error-${item.progressId}`
          )
          .map(item => item.progressId)
      )
    )
    if (!outcome || input.readNotice() !== notice) return
    if (outcome.status === 'reconciled') {
      input.showNotice(null)
      return
    }
    const messageKey =
      outcome.status === 'superseded' || outcome.errorCode === 'INTENT_SUPERSEDED'
        ? 'plugins_local_sync_superseded'
        : outcome.httpStatus === 403
          ? 'plugins_local_recovery_denied'
          : outcome.httpStatus === 404
            ? 'plugins_local_recovery_missing'
            : 'plugins_local_recovery_rejected'
    input.showNotice({
      id: `plugin-recovery-error-${outcome.progressId}`,
      kind: 'error',
      message: input.t(`workbench.${messageKey}`),
    })
  }
  return {
    reconcile,
    subscribe() {
      const receive = (event: Event) => {
        const next = (event as CustomEvent<PluginRecoveryOutcomesEvent>).detail
        if (next?.scopeKey !== input.scopeKey()) return
        reply = next
        reconcile()
      }
      window.addEventListener(PLUGIN_LOCAL_RECOVERY_OUTCOMES, receive)
      return () => {
        window.removeEventListener(PLUGIN_LOCAL_RECOVERY_OUTCOMES, receive)
        reply = undefined
      }
    },
    showPending(error: unknown) {
      const progressId = pendingPluginRecoveryId(error)
      if (!progressId) return false
      input.showNotice({
        id: `plugin-recovery-${progressId}`,
        kind: 'progress',
        message: getErrorMessage(error, input.t('workbench.plugins_local_sync_processing')),
      })
      return true
    },
    reportProgress: (id: string, isCurrent: () => boolean) => (phase: PluginOperationPhase) => {
      if (!isCurrent()) return
      if (phase === 'settled') {
        if (input.readNotice()?.id === id) input.showNotice(null)
        return
      }
      input.showNotice({
        id,
        kind: 'progress',
        message: input.t(
          phase === 'confirming'
            ? 'workbench.plugins_local_sync_confirmation_pending'
            : 'workbench.plugins_local_sync_processing'
        ),
      })
    },
  }
}
