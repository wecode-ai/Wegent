import { useState, useSyncExternalStore } from 'react'
import { workbenchCacheScope } from './remoteRuntimeWorkCache'
import { createWorkbenchDataRefreshSource } from './workbenchDataRefreshSource'
import type { WorkbenchDataRefreshOptions } from './workbenchDataRefreshTypes'

export function useWorkbenchDataRefresh(options: WorkbenchDataRefreshOptions) {
  const [owner, setOwner] = useState(() => createWorkbenchDataRefreshSource(options))
  let source = owner
  const cacheScope = workbenchCacheScope(options.ownershipKey ?? '', options.user.id)
  if (source.cacheScope !== cacheScope || source.stateSource !== options.stateSource) {
    source = createWorkbenchDataRefreshSource(options, true)
    setOwner(source)
  }
  const cloudWorkStatus = useSyncExternalStore(
    listener => source.subscribe(options, listener),
    source.getSnapshot,
    source.getSnapshot
  )
  return { cloudWorkStatus, ...source.commands }
}
