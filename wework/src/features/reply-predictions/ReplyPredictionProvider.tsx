import { useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  ComposerPredictionContext,
  ComposerPredictionPendingContext,
} from '@wegent/collaboration/composer'
import { useTranslation } from '@/hooks/useTranslation'
import { WorkbenchContext, WorkbenchPaneContext } from '@/features/workbench/workbenchContexts'
import { RuntimeTaskLifecycleContext } from '@/features/workbench/runtimeTaskLifecycle/internalContext'
import type { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  replyPredictionKey,
  replyPredictionService,
  runtimeReplyPredictionSource,
} from './replyPredictionService'
import { ReplyPredictionFeedContext } from './replyPredictionFeedContext'
import { reportReplyPredictionFeedError } from './replyPredictionFeed'
import { createReplyPredictionViews } from './replyPredictionViews'

const noSubscription = () => () => {}
const emptySnapshot = () => null

function createPredictionTaskReader(store: RuntimeTaskLifecycleStore | null) {
  const report = (error: unknown) => reportReplyPredictionFeedError(error)
  return {
    subscribe(listener: () => void) {
      try {
        return store?.subscribe(listener) ?? noSubscription()
      } catch (error) {
        report(error)
        return noSubscription()
      }
    },
    getSnapshot() {
      try {
        return store?.getSnapshot() ?? null
      } catch (error) {
        report(error)
        return null
      }
    },
    selectTask(
      snapshot: ReturnType<RuntimeTaskLifecycleStore['getSnapshot']> | null,
      address?: RuntimeTaskAddress | null
    ) {
      if (!snapshot || !address) return null
      try {
        return store?.selectTask(snapshot, address) ?? null
      } catch (error) {
        report(error)
        return null
      }
    },
  }
}

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
  const taskReader = useMemo(() => createPredictionTaskReader(store), [store])
  const snapshot = useSyncExternalStore(taskReader.subscribe, taskReader.getSnapshot)
  const lifecycle = taskReader.selectTask(snapshot, address)
  const enabled = preferences?.loaded && preferences.preferences.replyPredictionsEnabled
  const api = enabled ? workbench?.services.replyPredictionApi : undefined
  const service = useMemo(() => {
    if (!api) return null
    try {
      return replyPredictionService(api)
    } catch (error) {
      reportReplyPredictionFeedError(error)
      return null
    }
  }, [api])
  const target = runtimeReplyPredictionSource(address, lifecycle)
  const feed = useContext(ReplyPredictionFeedContext)
  const key = target ? replyPredictionKey(target) : ''
  const entry = feed?.service === service && target ? feed.entries.get(target.scope) : undefined
  const feedOwnsRequest = Boolean(entry && (entry.key !== key || entry.busy || entry.requested))
  const [views] = useState(createReplyPredictionViews)
  const view = views.resolve(feedOwnsRequest ? null : service, target)
  const ownResult = useSyncExternalStore(
    view?.subscribe ?? noSubscription,
    view?.getSnapshot ?? emptySnapshot
  )
  const result = feedOwnsRequest ? (entry?.key === key ? entry : null) : ownResult
  const busy = Boolean(target?.busy || (feedOwnsRequest && entry?.busy))
  const prediction =
    !blocked && !busy && enabled && result?.prediction?.isCurrent() ? result.prediction : null
  return (
    <ComposerPredictionContext.Provider
      value={
        prediction
          ? {
              text: prediction.text,
              acceptLabel: t('workbench.reply_prediction_accept'),
              onAccept: () => {
                if (feedOwnsRequest && target) feed?.accept(target.scope, key)
                else view?.accept()
              },
            }
          : null
      }
    >
      <ComposerPredictionPendingContext.Provider
        value={
          !blocked && !busy && enabled && result?.pending
            ? t('workbench.reply_prediction_generating')
            : null
        }
      >
        {children}
      </ComposerPredictionPendingContext.Provider>
    </ComposerPredictionContext.Provider>
  )
}
