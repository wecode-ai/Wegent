import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  QuestionDiscussionStoreContext,
  type QuestionDiscussionSession,
} from './questionDiscussion'

/** Keep answer drafts shared when the same request appears in different task tabs. */
export function QuestionDiscussionProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Record<string, QuestionDiscussionSession>>({})
  const creating = useRef(new Map<string, Promise<RuntimeTaskAddress | false>>())
  const update = useCallback(
    (
      key: string,
      apply: (session: QuestionDiscussionSession | undefined) => QuestionDiscussionSession
    ) => {
      setSessions(current => ({ ...current, [key]: apply(current[key]) }))
    },
    []
  )
  const create = useCallback(
    async (key: string, start: () => Promise<RuntimeTaskAddress | false>) => {
      const existing = creating.current.get(key)
      if (existing) return existing
      const promise = start()
      creating.current.set(key, promise)
      try {
        const address = await promise
        if (address) update(key, current => ({ ...current!, address }))
        return address
      } finally {
        creating.current.delete(key)
      }
    },
    [update]
  )
  const value = useMemo(() => ({ sessions, update, create }), [sessions, update, create])
  return (
    <QuestionDiscussionStoreContext.Provider value={value}>
      {children}
    </QuestionDiscussionStoreContext.Provider>
  )
}
