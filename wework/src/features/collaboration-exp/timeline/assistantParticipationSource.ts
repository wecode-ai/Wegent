import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { AssistantParticipation, SharedWorkspaceApi } from '@wegent/collaboration'

/** Participation metadata and explicit source reads share the mounted timeline lifetime. */
export function createAssistantParticipationSource(
  api: SharedWorkspaceApi,
  issueId: string,
  scope: string
) {
  const resource = createAsyncResource<AssistantParticipation[]>(scope, () =>
    api.issues.listAssistantParticipations!(issueId)
  )
  let readers = 0
  let revision = 0
  return {
    ...resource,
    subscribe(notify: () => void, version: unknown) {
      readers++
      const stop = resource.subscribe(notify, version)
      return () => {
        stop()
        if (!--readers) revision++
      }
    },
    async read(participation: AssistantParticipation) {
      const read = api.issues.readAssistantParticipation
      if (!readers || participation.historyState !== 'unverified' || !read) return
      const request = ++revision
      try {
        const workroom = await read(issueId, participation.id)
        if (readers && request === revision)
          return { workroom, isCurrent: () => readers > 0 && request === revision }
      } catch {
        // The source access state remains authoritative and unchanged on a failed read.
      }
    },
  }
}
