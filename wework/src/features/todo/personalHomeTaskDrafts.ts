import type { CollaborationIssue } from '@wegent/collaboration'
import type { Attachment } from '@wegent/chat-core/runtime'

/** The collaboration host owns unfinished starts across page navigation. */
export interface PersonalHomeTaskDraft {
  issue?: CollaborationIssue
  value: string
  requestedTitle: string
  pendingContentUpdate: boolean
  attachments: Attachment[]
  goalDraftActive: boolean
  pendingFiles?: File[]
  attachmentFiles?: Map<number, File>
}

export type PersonalHomeTaskDrafts = Map<string, PersonalHomeTaskDraft>

export interface PersonalHomeTaskDraftStore {
  get(scope: string, sources: readonly unknown[]): PersonalHomeTaskDrafts
}

/** The workbench owns drafts; account and service changes discard the old scope. */
export function createPersonalHomeTaskDraftStore(): PersonalHomeTaskDraftStore {
  let cache:
    | { scope: string; sources: readonly unknown[]; drafts: PersonalHomeTaskDrafts }
    | undefined
  return {
    get(scope, sources) {
      if (
        !cache ||
        cache.scope !== scope ||
        cache.sources.length !== sources.length ||
        cache.sources.some((source, index) => source !== sources[index])
      )
        cache = { scope, sources: [...sources], drafts: new Map() }
      return cache.drafts
    },
  }
}
