import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  QuestionDiscussionStoreContext,
  type QuestionDiscussionSession,
  type QuestionDiscussionRequest,
} from './questionDiscussion'

/** Keep answer drafts shared when the same request appears in different task tabs. */
export function QuestionDiscussionProvider({
  children,
  accountKey = 'local',
}: {
  children: ReactNode
  accountKey?: string
}) {
  const [accounts, setAccounts] = useState<
    Record<string, Record<string, QuestionDiscussionSession>>
  >({})
  const sessions = accounts[accountKey] ?? EMPTY_SESSIONS
  const [pendingPanel, setPendingPanel] = useState<{
    accountKey: string
    request: QuestionDiscussionRequest
  } | null>(null)
  const [panelAccount, setPanelAccount] = useState(accountKey)
  if (panelAccount !== accountKey) {
    setPanelAccount(accountKey)
    setPendingPanel(null)
  }
  const panelRequest = pendingPanel?.accountKey === accountKey ? pendingPanel.request : null
  const requestPanel = useCallback(
    (request: QuestionDiscussionRequest) => {
      setPendingPanel({ accountKey, request })
    },
    [accountKey]
  )
  const consumePanelRequest = useCallback(
    (request: QuestionDiscussionRequest) => {
      setPendingPanel(current =>
        current?.accountKey === accountKey && current.request === request ? null : current
      )
    },
    [accountKey]
  )
  const creating = useRef(new Map<string, Promise<RuntimeTaskAddress | false>>())
  const update = useCallback(
    (
      key: string,
      apply: (session: QuestionDiscussionSession | undefined) => QuestionDiscussionSession
    ) => {
      setAccounts(current => ({
        ...current,
        [accountKey]: {
          ...current[accountKey],
          [key]: apply(current[accountKey]?.[key]),
        },
      }))
    },
    [accountKey]
  )
  const create = useCallback(
    async (key: string, start: () => Promise<RuntimeTaskAddress | false>) => {
      const creationKey = JSON.stringify([accountKey, key])
      const existing = creating.current.get(creationKey)
      if (existing) return existing
      const promise = start()
      creating.current.set(creationKey, promise)
      try {
        const address = await promise
        if (address) update(key, current => ({ ...current!, address }))
        return address
      } finally {
        creating.current.delete(creationKey)
      }
    },
    [accountKey, update]
  )
  const value = useMemo(
    () => ({
      accountKey,
      sessions,
      update,
      create,
      panelRequest,
      requestPanel,
      consumePanelRequest,
    }),
    [accountKey, sessions, update, create, panelRequest, requestPanel, consumePanelRequest]
  )
  return (
    <QuestionDiscussionStoreContext.Provider value={value}>
      {children}
    </QuestionDiscussionStoreContext.Provider>
  )
}

const EMPTY_SESSIONS: Record<string, QuestionDiscussionSession> = {}
