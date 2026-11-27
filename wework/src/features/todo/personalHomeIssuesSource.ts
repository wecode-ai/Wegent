import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { createPersonalHomeIssuesSource as sharedSource } from '@wegent/collaboration/platform'
import {
  subscribeProjectSpaceTaskBindingChanged,
  subscribeProjectSpaceTaskContextChanged,
} from './projectSpaceSelection'

export type {
  PersonalHomeCreationNotice,
  PersonalHomeIssueOrder,
} from '@wegent/collaboration/platform'

export function subscribePersonalIssueChanges(reload: () => void) {
  const stopBinding = subscribeProjectSpaceTaskBindingChanged(reload)
  const stopContext = subscribeProjectSpaceTaskContextChanged(reload)
  return () => {
    stopBinding()
    stopContext()
  }
}

export function createPersonalHomeIssuesSource(
  sources: SharedWorkspaceApi[],
  query: Parameters<typeof sharedSource>[1],
  initial?: Parameters<typeof sharedSource<SharedWorkspaceApi>>[2]
) {
  return sharedSource(sources, query, initial, subscribePersonalIssueChanges)
}
