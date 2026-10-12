import {
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  ComposerPredictionContext,
  ComposerPredictionPendingContext,
} from '@wegent/collaboration/composer'
import { useTranslation } from '@/hooks/useTranslation'
import { WorkbenchContext, WorkbenchPaneContext } from '@/features/workbench/workbenchContexts'
import { RuntimeTaskLifecycleContext } from '@/features/workbench/runtimeTaskLifecycle/internalContext'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  replyPredictionService,
  type ReplyPredictionSource,
  type ReplyPredictionResult,
} from './replyPredictionService'

const noSubscription = () => () => {}
const emptySnapshot = () => null

export function ReplyPredictionProvider({
  address,
  blocked = false,
  children,
}: {
  address?: RuntimeTaskAddress | null
  blocked?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation('common')
  const globalWorkbench = useContext(WorkbenchContext)
  const paneWorkbench = useContext(WorkbenchPaneContext)
  const workbench = paneWorkbench ?? globalWorkbench
  const preferences = useAppPreferencesState()
  const store = useContext(RuntimeTaskLifecycleContext)
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.getSnapshot ?? emptySnapshot
  )
  const lifecycle = snapshot && address ? store?.selectTask(snapshot, address) : null
  const enabled = preferences?.loaded && preferences.preferences.replyPredictionsEnabled
  const api = enabled ? workbench?.services.replyPredictionApi : undefined
  const service = useMemo(() => (api ? replyPredictionService(api) : null), [api])
  useSyncExternalStore(service?.subscribe ?? noSubscription, service?.getSnapshot ?? emptySnapshot)
  const runtimeRevision = `${lifecycle?.turn.id ?? ''}:${lifecycle?.task?.updatedAt ?? ''}`
  const runtimeBusy = lifecycle?.derived.isBusy || Boolean(lifecycle?.interactionStatus)
  const deviceId = address?.deviceId
  const taskId = address?.taskId
  const workspacePath = address?.workspacePath
  const latestTurnId = lifecycle?.turn.id
  const runtimeSource = useMemo<ReplyPredictionSource | null>(() => {
    if (!deviceId || !taskId) return null
    return {
      scope: JSON.stringify([deviceId, taskId, workspacePath]),
      revision: runtimeRevision,
      busy: Boolean(runtimeBusy),
      address: { deviceId, taskId, workspacePath },
      latestTurnId,
    }
  }, [deviceId, taskId, workspacePath, runtimeRevision, runtimeBusy, latestTurnId])
  const target = runtimeSource
  const scope = target?.scope
  const revision = target?.revision ?? ''
  const busy = target?.busy ?? false
  const currentSource = useEffectEvent(() => target!)
  const [result, setResult] = useState<{
    key: string
    prediction: ReplyPredictionResult | null
  } | null>(null)
  const resultKey = JSON.stringify([target?.scope, target?.latestTurnId || revision])
  useEffect(() => {
    if (!service || !scope) return
    if (busy) {
      service.invalidate(scope)
      return
    }
    let disposed = false
    const release = service.retain(scope)
    void service
      .request(currentSource())
      .then(prediction => {
        if (!disposed) setResult({ key: resultKey, prediction })
      })
      .catch(() => {
        if (!disposed) setResult({ key: resultKey, prediction: null })
      })
    return () => {
      disposed = true
      release()
    }
  }, [service, scope, busy, resultKey])
  const prediction =
    !blocked &&
    !target?.busy &&
    enabled &&
    result?.key === resultKey &&
    result.prediction?.isCurrent()
      ? result.prediction
      : null
  return (
    <ComposerPredictionContext.Provider
      value={
        prediction
          ? {
              text: prediction.text,
              acceptLabel: t('workbench.reply_prediction_accept'),
              onAccept: () => {
                prediction.onAccept()
                setResult({ key: resultKey, prediction: null })
              },
            }
          : null
      }
    >
      <ComposerPredictionPendingContext.Provider
        value={
          !blocked && !busy && enabled && scope && service?.isPending(scope)
            ? t('workbench.reply_prediction_generating')
            : null
        }
      >
        {children}
      </ComposerPredictionPendingContext.Provider>
    </ComposerPredictionContext.Provider>
  )
}
