import {
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useLayoutEffect,
  useRef,
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
  replyPredictionKey,
  replyPredictionService,
  type ReplyPredictionSource,
  type ReplyPredictionResult,
} from './replyPredictionService'
import {
  recordPredictionEffect,
  type PredictionEffectDiagnosticContext,
} from './replyPredictionDiagnostics'

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
  const runtimeBusy = lifecycle?.derived.isBusy || Boolean(lifecycle?.interactionStatus)
  const deviceId = address?.deviceId
  const taskId = address?.taskId
  const workspacePath = address?.workspacePath
  const latestTurnId = lifecycle?.turn.latestId ?? undefined
  const runtimeRevision = latestTurnId ?? ''
  const modelSelection = lifecycle?.task?.modelSelection
  const runtimeSource = useMemo<ReplyPredictionSource | null>(() => {
    const workspaceBacked = address?.workspaceKind !== 'chat' && !address?.projectSession
    if (!address || !deviceId || !taskId || !latestTurnId || (workspaceBacked && !workspacePath))
      return null
    return {
      scope: JSON.stringify([deviceId, taskId, workspaceBacked ? workspacePath : null]),
      revision: runtimeRevision,
      busy: Boolean(runtimeBusy),
      address,
      modelSelection,
      latestTurnId,
    }
  }, [
    address,
    deviceId,
    taskId,
    workspacePath,
    runtimeRevision,
    runtimeBusy,
    latestTurnId,
    modelSelection,
  ])
  const target = runtimeSource
  const scope = target?.scope
  const busy = target?.busy ?? false
  const currentSource = useEffectEvent(() => target!)
  const [result, setResult] = useState<{
    key: string
    prediction: ReplyPredictionResult | null
  } | null>(null)
  const resultKey = target ? replyPredictionKey(target) : ''
  const diagnosticProvider = useRef({})
  const diagnosticContext = useRef<PredictionEffectDiagnosticContext | null>(null)
  useLayoutEffect(() => {
    diagnosticContext.current = {
      api,
      service,
      source: target,
      key: resultKey,
      busy,
      enabled: Boolean(enabled),
    }
    return () => {
      diagnosticContext.current = null
    }
  })
  useEffect(() => {
    const context = diagnosticContext.current!
    const provider = diagnosticProvider.current
    recordPredictionEffect('start', provider, context)
    const recordCleanup = () =>
      recordPredictionEffect('cleanup', provider, context, diagnosticContext.current)
    if (!service || !scope) return recordCleanup
    if (busy) {
      service.invalidate(scope, 'busy')
      return recordCleanup
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
      recordCleanup()
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
        {!blocked && !busy && enabled && scope && service?.hasError(scope) && (
          <p
            role="status"
            className="mt-1 text-xs text-text-secondary"
            data-testid="reply-prediction-error"
          >
            {t('workbench.reply_prediction_failed')}
          </p>
        )}
      </ComposerPredictionPendingContext.Provider>
    </ComposerPredictionContext.Provider>
  )
}
