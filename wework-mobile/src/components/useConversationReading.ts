import type { LegendListRef } from '@legendapp/list/react-native'
import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react'

export const ConversationFollowingContext = createContext(true)
const unsubscribeNothing = () => {}

/** Read LegendList's own end-following state without a second scroll controller. */
export function useConversationFollowing(
  listRef: RefObject<LegendListRef | null>,
  dataKey: string
) {
  const [ready, setReady] = useState(0)
  const onReady = useCallback(() => setReady(value => value + 1), [])
  const subscribe = useCallback(
    (changed: () => void) => {
      const state = listRef.current?.getState()
      return state?.listen('isFollowingEnd', changed) ?? unsubscribeNothing
    },
    [listRef, dataKey, ready]
  )
  const snapshot = useCallback(
    () => listRef.current?.getState().isFollowingEnd ?? true,
    [listRef, dataKey]
  )
  const following = useSyncExternalStore(subscribe, snapshot, () => true)
  return { following, onReady }
}

/** Defer new automatic folds while browsing; never reopen an existing fold. */
export function useAutomaticCollapse(eligible: boolean): boolean {
  const following = useContext(ConversationFollowingContext)
  const [applied, setApplied] = useState(eligible)
  if (applied !== eligible && (!eligible || following)) setApplied(eligible)
  return eligible && (applied || following)
}
