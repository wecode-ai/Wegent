import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  clearDeferredPluginRecoveries,
  deferredPluginRecoveryIds,
  PLUGIN_LOCAL_RECOVERY_OUTCOMES,
  type PluginRecoveryOutcomesEvent,
} from '@/features/plugins/pluginLocalSync'
import type { PluginOperationNoticeState } from '../PluginOperationNotice'

export function usePluginRecoveryNotice(
  scopeKey: string,
  notice: PluginOperationNoticeState | null,
  setNotice: Dispatch<SetStateAction<PluginOperationNoticeState | null>>
) {
  const { t } = useTranslation('common')
  const [pluginRecoveryReply, setPluginRecoveryReply] = useState<PluginRecoveryOutcomesEvent>()
  useEffect(() => {
    const onRecovery = (event: Event) => {
      const reply = (event as CustomEvent<PluginRecoveryOutcomesEvent>).detail
      if (reply?.scopeKey === scopeKey) setPluginRecoveryReply(reply)
    }
    window.addEventListener(PLUGIN_LOCAL_RECOVERY_OUTCOMES, onRecovery)
    return () => window.removeEventListener(PLUGIN_LOCAL_RECOVERY_OUTCOMES, onRecovery)
  }, [scopeKey])
  useEffect(() => {
    if (pluginRecoveryReply?.scopeKey !== scopeKey) return
    const { outcomes } = pluginRecoveryReply
    const deferred = new Set(deferredPluginRecoveryIds())
    const outcome = notice
      ? outcomes.find(item => notice.id === `plugin-recovery-${item.progressId}`)
      : outcomes.find(item => item.status !== 'reconciled' && deferred.has(item.progressId))
    const settled = new Set(
      outcomes
        .filter(
          item =>
            item.status === 'reconciled' ||
            notice?.id === `plugin-recovery-error-${item.progressId}`
        )
        .map(item => item.progressId)
    )
    clearDeferredPluginRecoveries(settled)
    if (!outcome) return
    setNotice(current => {
      if (current !== notice) return current
      if (outcome.status === 'reconciled') return null
      const messageKey =
        outcome.status === 'superseded' || outcome.errorCode === 'INTENT_SUPERSEDED'
          ? 'plugins_local_sync_superseded'
          : outcome.httpStatus === 403
            ? 'plugins_local_recovery_denied'
            : outcome.httpStatus === 404
              ? 'plugins_local_recovery_missing'
              : 'plugins_local_recovery_rejected'
      return {
        id: `plugin-recovery-error-${outcome.progressId}`,
        kind: 'error',
        message: t(`workbench.${messageKey}`),
      }
    })
  }, [notice, pluginRecoveryReply, scopeKey, setNotice, t])
}
