import { useCallback, useState, useSyncExternalStore } from 'react'
import {
  createPersonalHomeIssuesSource,
  type PersonalHomeIssueOrder,
  type PersonalHomeIssueSource,
  type PersonalHomeCreationNotice,
  type SubscribePersonalIssueChanges,
} from './personalHomeIssuesSource'
export type { PersonalHomeIssueOrder } from './personalHomeIssuesSource'
const subscribeInactive = () => () => undefined

/** Each store publishes one bounded page independently; cards never fetch their own context. */
export function usePersonalHomeIssues<Source extends PersonalHomeIssueSource>(
  sources: Source[],
  active: boolean,
  assignedOnly: boolean,
  includeCompleted: boolean,
  viewerIds: readonly (string | number)[],
  order: PersonalHomeIssueOrder = 'attention',
  scope: 'assigned' | 'created' | 'participating' = assignedOnly ? 'assigned' : 'participating',
  creation?: PersonalHomeCreationNotice,
  subscribeChanges?: SubscribePersonalIssueChanges
) {
  const queryKey = JSON.stringify([scope, includeCompleted, viewerIds, order])
  const [owner, setOwner] = useState(() => ({
    sources: [...sources],
    queryKey,
    source: createPersonalHomeIssuesSource(
      sources,
      { scope, includeCompleted, viewerIds: [...viewerIds], order },
      undefined,
      subscribeChanges
    ),
  }))
  if (
    owner.queryKey !== queryKey ||
    owner.sources.length !== sources.length ||
    owner.sources.some((api, index) => api !== sources[index])
  ) {
    const previous = owner.source.getSnapshot()
    setOwner({
      sources: [...sources],
      queryKey,
      source: createPersonalHomeIssuesSource(
        sources,
        { scope, includeCompleted, viewerIds: [...viewerIds], order },
        owner.queryKey === queryKey ? previous : { rows: [], revision: previous.revision },
        subscribeChanges
      ),
    })
  }
  const creationKey = creation?.key
  const onCreationHandled = creation?.onHandled
  const subscribe = useCallback(
    (listener: () => void) =>
      owner.source.subscribe(
        listener,
        active,
        creationKey === undefined ? undefined : { key: creationKey, onHandled: onCreationHandled }
      ),
    [owner.source, active, creationKey, onCreationHandled]
  )
  const snapshot = useSyncExternalStore(
    active || creation ? subscribe : subscribeInactive,
    owner.source.getSnapshot,
    owner.source.getSnapshot
  )
  const current = snapshot.rows.map(row => ({ ...row, loading: active && row.loading }))
  return {
    sourceSnapshots: current,
    revision: snapshot.revision,
    items: current.flatMap(row => row.items),
    loading: current.some(row => row.loading),
    error: current.some(row => row.error),
    hasMore: current.some(row => row.nextCursor !== null),
    canLoadMore: current.some(row => row.nextCursor !== null && !row.loading),
    reload: owner.source.reload,
    loadMore: owner.source.loadMore,
    replaceIssue: owner.source.replaceIssue,
  }
}
