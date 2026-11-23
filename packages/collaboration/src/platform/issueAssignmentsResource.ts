import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { SharedWorkspaceAssignmentsApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationAssignment } from '../types'

type Assignments = Record<string, CollaborationAssignment[]>
const EMPTY_ASSIGNMENTS: CollaborationAssignment[] = []

/** Each issue owns its read so a committed mutation only invalidates that issue. */
export function createIssueAssignmentsCatalog(api: SharedWorkspaceAssignmentsApi | undefined) {
  const resources = new Map<string, ReturnType<typeof createResource>>()
  function createResource(id: string) {
    return createAsyncResource(id, () => api?.list(id) ?? Promise.resolve([]), {
      refreshOnSubscribe: true,
    })
  }
  function resource(id: string) {
    let current = resources.get(id)
    if (!current) {
      current = createResource(id)
      resources.set(id, current)
    }
    return current
  }
  return {
    select(ids: string[]) {
      const selected = [...new Set(ids)].map(id => [id, resource(id)] as const)
      const read = (): Assignments =>
        Object.fromEntries(
          selected.map(([id, entry]) => [id, entry.getSnapshot().data ?? EMPTY_ASSIGNMENTS])
        )
      let snapshot = read()
      return {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) {
          const cleanups = selected.map(([id, entry]) =>
            entry.subscribe(() => {
              const assignments = entry.getSnapshot().data ?? EMPTY_ASSIGNMENTS
              if (snapshot[id] === assignments) return
              snapshot = { ...snapshot, [id]: assignments }
              listener()
            })
          )
          return () => cleanups.forEach(cleanup => cleanup())
        },
        replace(issueId: string, assignments: CollaborationAssignment[]) {
          const entry = selected.find(([id]) => id === issueId)?.[1]
          entry?.update(() => assignments)
        },
      }
    },
  }
}
