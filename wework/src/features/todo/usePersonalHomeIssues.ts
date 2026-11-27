import { usePersonalHomeIssues as useSharedPersonalHomeIssues } from '@wegent/collaboration/platform'
import {
  subscribePersonalIssueChanges,
  type PersonalHomeCreationNotice,
  type PersonalHomeIssueOrder,
} from './personalHomeIssuesSource'

export type { PersonalHomeIssueOrder } from './personalHomeIssuesSource'

export function usePersonalHomeIssues(
  sources: Parameters<typeof useSharedPersonalHomeIssues>[0],
  active: boolean,
  assignedOnly: boolean,
  includeCompleted: boolean,
  viewerIds: readonly (string | number)[],
  order?: PersonalHomeIssueOrder,
  scope?: 'assigned' | 'created' | 'participating',
  creation?: PersonalHomeCreationNotice
) {
  return useSharedPersonalHomeIssues(
    sources,
    active,
    assignedOnly,
    includeCompleted,
    viewerIds,
    order,
    scope,
    creation,
    subscribePersonalIssueChanges
  )
}
