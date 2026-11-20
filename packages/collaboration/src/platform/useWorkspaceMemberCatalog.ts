import { useCallback } from 'react'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationWorkspace, CollaborationWorkspaceMember } from '../types'
import { usePanelData } from './usePanelData'

export function useWorkspaceMemberCatalog(
  api: SharedWorkspaceApi,
  workspaces: CollaborationWorkspace[],
  enabled: boolean
) {
  const loadMembers = useCallback(async (): Promise<
    Record<string, CollaborationWorkspaceMember[]>
  > => {
    if (!api.workspaces) return {}
    const entries = await Promise.all(
      workspaces.map(
        async workspace => [workspace.id, await api.workspaces!.listMembers(workspace.id)] as const
      )
    )
    return Object.fromEntries(entries)
  }, [api, workspaces])
  const members = usePanelData(loadMembers, enabled && Boolean(api.workspaces))
  return members.error !== undefined ? {} : (members.data ?? {})
}
