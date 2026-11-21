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
  sources: Parameters<typeof sharedSource>[0],
  query: Parameters<typeof sharedSource>[1],
  initial?: Parameters<typeof sharedSource>[2]
) {
  return sharedSource(sources, query, initial, subscribePersonalIssueChanges)
}
