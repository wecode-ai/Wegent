// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo } from 'react'
import type { CollaborationTranslate } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationWorkspace, CollaborationWorkspaceMember } from '../types'
import { WorkspaceMembersConfiguration } from './WorkspaceMembersConfiguration'
import {
  WorkspaceCollaborationGroupsConfiguration,
  type WorkspaceResourceCommands,
} from './WorkspaceResourceConfiguration'

import { usePanelData, PanelFeedback } from './usePanelData'

export function WorkspaceMembersPanel({
  api,
  workspace,
  commands,
  locale,
  translate,
}: {
  api: SharedWorkspaceApi
  workspace: CollaborationWorkspace
  commands: WorkspaceResourceCommands
  locale: 'zh-CN' | 'en'
  translate: CollaborationTranslate
}) {
  const load = useCallback(() => api.workspaces!.listMembers(workspace.id), [api, workspace.id])
  const state = usePanelData(load)
  const { setData, refresh } = state
  const memberCommands = useMemo<WorkspaceResourceCommands>(() => {
    const save = (member: CollaborationWorkspaceMember) => {
      setData(rows => [...(rows ?? []).filter(row => row.user_id !== member.user_id), member])
      return member
    }
    return {
      ...commands,
      addMember: async (userId, role) => save(await commands.addMember(userId, role)),
      updateMember: async (userId, role) => {
        const member = await commands.updateMember(userId, role)
        setData(rows => rows?.map(row => (row.user_id === userId ? member : row)))
        return member
      },
      removeMember: async userId => {
        await commands.removeMember(userId)
        setData(rows => rows?.filter(row => row.user_id !== userId))
      },
      transferOwnership: commands.transferOwnership
        ? async (userId, version) => {
            await commands.transferOwnership!(userId, version)
            await refresh()
          }
        : undefined,
    }
  }, [commands, setData, refresh])
  return (
    <>
      <PanelFeedback state={state} translate={translate} testId="workspace-members" />
      {state.data !== undefined && (
        <WorkspaceMembersConfiguration
          workspace={workspace}
          members={state.data}
          commands={memberCommands}
          locale={locale}
        />
      )}
    </>
  )
}

export function WorkspaceGroupsPanel({
  api,
  workspace,
  commands,
  locale,
  translate,
  currentUserId,
  initialCreateOpen,
  onCreateOpenChange,
}: {
  api: SharedWorkspaceApi
  workspace: CollaborationWorkspace
  commands: WorkspaceResourceCommands
  locale: 'zh-CN' | 'en'
  translate: CollaborationTranslate
  currentUserId?: number
  initialCreateOpen: boolean
  onCreateOpenChange(open: boolean): void
}) {
  const load = useCallback(
    () => api.workspaces!.listCollaborationGroups(workspace.id),
    [api, workspace.id]
  )
  const loadParticipants = useCallback(async () => {
    const [members, agents] = await Promise.all([
      api.workspaces!.listMembers(workspace.id),
      api.workspaces!.listAgents(workspace.id),
    ])
    return { members, agents }
  }, [api, workspace.id])
  const state = usePanelData(load)
  const { setData } = state
  const groupCommands = useMemo<WorkspaceResourceCommands>(
    () => ({
      ...commands,
      createCollaborationGroup: async input => {
        const group = await commands.createCollaborationGroup(input)
        setData(data => data && [...data, group])
        return group
      },
      updateCollaborationGroup: commands.updateCollaborationGroup
        ? async (id, input) => {
            const group = await commands.updateCollaborationGroup!(id, input)
            setData(data => data?.map(row => (row.id === id ? group : row)))
            return group
          }
        : undefined,
      removeCollaborationGroup: async id => {
        await commands.removeCollaborationGroup(id)
        setData(data => data?.filter(row => row.id !== id))
      },
    }),
    [commands, setData]
  )
  return (
    <>
      <PanelFeedback state={state} translate={translate} testId="workspace-groups" />
      {state.data && (
        <WorkspaceCollaborationGroupsConfiguration
          workspace={workspace}
          groups={state.data}
          members={[]}
          agents={[]}
          loadParticipants={loadParticipants}
          commands={groupCommands}
          locale={locale}
          currentUserId={currentUserId}
          initialCreateOpen={initialCreateOpen}
          onCreateOpenChange={onCreateOpenChange}
        />
      )}
    </>
  )
}
