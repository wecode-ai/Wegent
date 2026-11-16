import type { CollaborationIssue } from '@wegent/collaboration'
import type { Attachment } from '@wegent/chat-core/runtime'
import { useState } from 'react'

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

export function usePersonalHomeTaskDrafts(
  scope: string,
  sources: readonly unknown[]
): PersonalHomeTaskDrafts {
  const [cache, setCache] = useState(() => ({
    scope,
    sources,
    drafts: new Map() as PersonalHomeTaskDrafts,
  }))
  if (
    cache.scope !== scope ||
    cache.sources.length !== sources.length ||
    cache.sources.some((source, index) => source !== sources[index])
  ) {
    const next = { scope, sources, drafts: new Map() as PersonalHomeTaskDrafts }
    setCache(next)
    return next.drafts
  }
  return cache.drafts
}
