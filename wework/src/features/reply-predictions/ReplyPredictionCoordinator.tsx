import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import type { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { replyPredictionService } from './replyPredictionService'
import { createReplyPredictionFeed, reportReplyPredictionFeedError } from './replyPredictionFeed'
import { ReplyPredictionFeedContext } from './replyPredictionFeedContext'

const noSubscription = () => () => {}
const noSnapshot = () => null

// The window feed stays outside task Activities and supplies their real prediction state.
export function ReplyPredictionCoordinator({
  services,
  store,
  children,
}: {
  services: WorkbenchServices
  store: RuntimeTaskLifecycleStore
  children?: ReactNode
}) {
  const preferences = useAppPreferencesState()
  const enabled = preferences?.loaded && preferences.preferences.replyPredictionsEnabled
  const api = enabled ? services.replyPredictionApi : undefined
  const source = useMemo(() => {
    if (!api) return null
    try {
      return createReplyPredictionFeed(replyPredictionService(api), store)
    } catch (error) {
      reportReplyPredictionFeedError(error)
      return null
    }
  }, [api, store])
  // Keep background predictions active without republishing the feed through context.
  useSyncExternalStore(source?.subscribe ?? noSubscription, noSnapshot, noSnapshot)
  return (
    <ReplyPredictionFeedContext.Provider value={source}>
      {children}
    </ReplyPredictionFeedContext.Provider>
  )
}
