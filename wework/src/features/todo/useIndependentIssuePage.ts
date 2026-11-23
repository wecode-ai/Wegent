import { useIndependentIssuePage as useSharedIssuePage } from '@wegent/collaboration/platform'
import type { PersonalIssueOrder, PersonalIssueScope } from '@/api/personalIssues'
import { useIndependentIssues } from './independentIssuesContext'

export function useIndependentIssuePage(
  scope: PersonalIssueScope,
  completed: boolean,
  active: boolean,
  archived = false,
  order: PersonalIssueOrder = 'attention'
) {
  const context = useIndependentIssues()
  const page = useSharedIssuePage(context, scope, completed, active, archived, order)
  return { ...page, context }
}
