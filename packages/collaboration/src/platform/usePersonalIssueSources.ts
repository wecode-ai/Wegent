import { useMemo } from 'react'
import type { PersonalIssuesApi } from './personalIssuesApi'
import type { PersonalHomeIssueSource } from './personalHomeIssuesSource'

export interface UnassignedIssueSource {
  api?: Pick<PersonalIssuesApi, 'list'> | null
  userId: number
  revision: number
}

export function usePersonalIssueSources(
  sources: PersonalHomeIssueSource[],
  unassigned: UnassignedIssueSource | null | undefined,
  archived = false
) {
  const api = unassigned?.api
  const userId = unassigned?.userId
  const revision = unassigned?.revision
  const source = useMemo<PersonalHomeIssueSource | null>(
    () =>
      api
        ? {
            myWork: {
              async page(input) {
                const page = await api.list(
                  input?.scope ?? 'participating',
                  input?.includeCompleted ?? false,
                  input?.cursor,
                  archived,
                  input?.order === 'recent' ? 'activity' : input?.order
                )
                return {
                  items: page.items,
                  nextCursor: page.next_cursor,
                }
              },
            },
          }
        : null,
    [api, userId, revision, archived]
  )
  return [...(archived ? [] : sources), ...(source ? [source] : [])]
}
