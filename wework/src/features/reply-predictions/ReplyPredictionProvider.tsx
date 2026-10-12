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
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import {
  predictionTurns,
  replyPredictionService,
  type ReplyPredictionSource,
  type ReplyPredictionResult,
} from './replyPredictionService'

const noSubscription = () => () => {}
const emptySnapshot = () => null

export function ReplyPredictionProvider({
  address,
  source,
  blocked = false,
  children,
}: {
  address?: RuntimeTaskAddress | null
  source?: ReplyPredictionSource | null
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
  const selectedModel = enabled ? workbench?.projectChat.selectedModel : null
  const selectedOptions = enabled ? workbench?.projectChat.selectedModelOptions : undefined
  const independentModel = preferences?.preferences.replyPredictionModel
  const configured = useMemo(() => {
    if (!enabled) return null
    if (independentModel) return independentModel
    if (!selectedModel) return null
    const execution = selectedModelExecutionFields(selectedModel, selectedOptions ?? {})
    return {
      modelName: selectedModel.name,
      modelType: selectedModel.type,
      executionModelId: execution.modelId ?? '',
      executionModelType: execution.modelType ?? null,
      options: execution.modelOptions,
    }
  }, [enabled, independentModel, selectedModel, selectedOptions])
  const model =
    configured &&
    workbench?.projectChat.models.some(
      candidate =>
        candidate.name === configured.modelName &&
        candidate.type === configured.modelType &&
        candidate.isActive !== false
    )
      ? configured
      : null
  const modelKey = JSON.stringify(model)
  const api = model ? workbench?.services.textGenerationApi : undefined
  const service = useMemo(
    () => (api ? replyPredictionService(api, modelKey) : null),
    [api, modelKey]
  )
  useSyncExternalStore(service?.subscribe ?? noSubscription, service?.getSnapshot ?? emptySnapshot)
  const runtimeRevision = `${lifecycle?.turn.id ?? ''}:${lifecycle?.task?.updatedAt ?? ''}`
  const runtimeBusy = lifecycle?.derived.isBusy || Boolean(lifecycle?.interactionStatus)
  const deviceId = address?.deviceId
  const taskId = address?.taskId
  const workspacePath = address?.workspacePath
  const loadTranscript = workbench?.loadRuntimeTranscriptForPane
  const runtimeSource = useMemo<ReplyPredictionSource | null>(() => {
    if (!deviceId || !taskId || !loadTranscript) return null
    return {
      scope: JSON.stringify([deviceId, taskId, workspacePath]),
      revision: runtimeRevision,
      busy: Boolean(runtimeBusy),
      load: async () =>
        predictionTurns(
          await loadTranscript({ deviceId, taskId, workspacePath }, { includeFullContent: true })
        ),
    }
  }, [deviceId, taskId, workspacePath, runtimeRevision, runtimeBusy, loadTranscript])
  const target = source === undefined ? runtimeSource : source
  const scope = target?.scope
  const revision = target?.revision ?? ''
  const busy = target?.busy ?? false
  const load = useEffectEvent(() => target!.load())
  const [result, setResult] = useState<{
    key: string
    prediction: ReplyPredictionResult | null
  } | null>(null)
  const resultKey = JSON.stringify([target?.scope, target?.revision, modelKey])

  useEffect(() => {
    service?.configure(model)
  }, [service, model])
  useEffect(() => {
    if (!service || !scope || !model) return
    if (busy) {
      service.invalidate(scope)
      return
    }
    let disposed = false
    const release = service.retain(scope)
    void service
      .request({ scope, revision, busy, load }, model)
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
  }, [service, scope, revision, busy, model, resultKey])
  const prediction =
    !blocked &&
    !target?.busy &&
    model &&
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
          !blocked && !busy && model && scope && service?.isPending(scope)
            ? t('workbench.reply_prediction_generating')
            : null
        }
      >
        {children}
      </ComposerPredictionPendingContext.Provider>
    </ComposerPredictionContext.Provider>
  )
}
