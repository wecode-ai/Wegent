import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { useWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useTranslation } from '@/hooks/useTranslation'
import { TransientNotice } from '@/components/common/TransientNotice'
import { useNotificationTaskSource } from './NotificationTaskSourceContext'
import { RuntimeInteractionsContext } from './RuntimeInteractionsContext'
import { NOTIFICATION_PREFERENCES_CHANGED_EVENT } from './notificationPreferences'
import { QuestionDiscussionProvider } from './QuestionDiscussionProvider'
import { useInteractionDrafts } from './useInteractionDrafts'
import { readPendingInteractionCache } from './interactionStorage'
import { createRuntimeInteractionsSource } from './runtimeInteractionsSource'

export function RuntimeInteractionsProvider({
  accountKey,
  children,
}: {
  accountKey: string
  children: ReactNode
}) {
  const source = useNotificationTaskSource()
  const tabs = useWorkspaceTabs()
  const { t } = useTranslation('common')
  const { drafts, replyDrafts, setDraft, discardDraft, retainDraft, retainedReply } =
    useInteractionDrafts(accountKey)
  const cached = useMemo(
    () => readPendingInteractionCache(`wework.interactions:${accountKey}:pending`),
    [accountKey]
  )
  const [owner, setOwner] = useState(() => ({
    accountKey,
    store: createRuntimeInteractionsSource(accountKey, cached, {
      source,
      tabs,
      t,
      setDraft,
      retainDraft,
      retainedReply,
    }),
  }))
  if (owner.accountKey !== accountKey)
    setOwner({
      accountKey,
      store: createRuntimeInteractionsSource(accountKey, cached, {
        source,
        tabs,
        t,
        setDraft,
        retainDraft,
        retainedReply,
      }),
    })
  const store = owner.store
  const observation = store.observe({
    source,
    tabs,
    t,
    setDraft,
    retainDraft,
    retainedReply,
  })
  const snapshot = useSyncExternalStore(
    observation.subscribe,
    observation.getSnapshot,
    observation.getSnapshot
  )
  useDOMEvent<StorageEvent>('window', 'storage', store.handleStorage)
  useDOMEvent('window', NOTIFICATION_PREFERENCES_CHANGED_EVENT, store.refreshPreferences)
  return (
    <RuntimeInteractionsContext.Provider
      value={{ ...snapshot.value, drafts, replyDrafts, setDraft, discardDraft }}
    >
      <QuestionDiscussionProvider accountKey={accountKey}>{children}</QuestionDiscussionProvider>
      <TransientNotice
        message={snapshot.replyNotice}
        tone="success"
        onClear={store.clearReplyNotice}
      />
    </RuntimeInteractionsContext.Provider>
  )
}
