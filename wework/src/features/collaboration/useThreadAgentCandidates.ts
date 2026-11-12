import { useEffect, useMemo, useState } from 'react'
import {
  normalizeProjectAgent,
  type CollaborationAgent,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { ChatGroupApi } from '@/api/chatGroups'

export interface ThreadAgentCandidate extends CollaborationAgent {
  source: { kind: 'group' | 'project'; name?: string }
}
interface SourceResult {
  agents: ThreadAgentCandidate[]
  failed: boolean
}

/** Optional project classification never blocks the group's own available agents. */
export function useThreadAgentCandidates({
  api,
  groups,
  groupId,
  threadId,
  accountScope,
  enabled,
  ownerRevision,
  threadRevision,
}: {
  api: SharedWorkspaceApi['agents']
  groups: ChatGroupApi
  groupId: string
  threadId: string | null
  accountScope?: string
  enabled: boolean
  ownerRevision?: object
  threadRevision?: number
}) {
  const [revision, setRevision] = useState(0)
  const scope = useMemo(
    () => ({
      api,
      groups,
      groupId,
      threadId,
      accountScope,
      enabled,
      revision,
      ownerRevision,
      threadRevision,
    }),
    [api, groups, groupId, threadId, accountScope, enabled, revision, ownerRevision, threadRevision]
  )
  const [result, setResult] = useState<{
    scope: typeof scope
    group?: SourceResult
    project?: SourceResult
  } | null>(null)
  useEffect(() => {
    if (!enabled || !threadId) return
    let active = true
    const loaded: { group?: SourceResult; project?: SourceResult } = {}
    const finish = (kind: 'group' | 'project', value: SourceResult) => {
      if (!active) return
      loaded[kind] = value
      setResult({ scope, ...loaded })
    }
    const load = async (id: string, source: ThreadAgentCandidate['source']) =>
      (await api.list(id, { forceRefresh: true }))
        .filter(row => !row.status || row.status === 'active')
        .map(row => ({ row, normalized: normalizeProjectAgent(row) }))
        .filter(({ normalized }) => normalized.canUse)
        .map(({ row, normalized }) => ({
          ...row,
          id: normalized.id,
          name: normalized.displayName,
          source,
        }))
    void load(groupId, { kind: 'group' }).then(
      agents => finish('group', { agents, failed: false }),
      () => finish('group', { agents: [], failed: true })
    )
    void Promise.resolve()
      .then(() => groups.projectLink(threadId))
      .then(async link =>
        link.project ? load(link.project.id, { kind: 'project', name: link.project.name }) : []
      )
      .then(
        agents => finish('project', { agents, failed: false }),
        () => finish('project', { agents: [], failed: true })
      )
    return () => {
      active = false
    }
  }, [api, groups, groupId, threadId, enabled, scope])
  const current = result?.scope === scope ? result : null
  const agents = enabled
    ? [...(current?.group?.agents ?? []), ...(current?.project?.agents ?? [])]
    : []
  return {
    agents,
    pending: enabled && (!current?.group || !current.project),
    failed: current?.group?.failed || current?.project?.failed || false,
    retry: () => setRevision(value => value + 1),
  }
}
