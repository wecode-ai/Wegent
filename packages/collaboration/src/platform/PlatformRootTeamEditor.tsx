import { DialogSurface } from '../controls/DialogSurface'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useSyncExternalStore } from 'react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { X } from 'lucide-react'
import { templateMessages } from '../templates/messages'
import { applyWorkspaceTemplate } from '../templates/workspaceConfiguration'
import { readTemplateAgents } from '../templates/agents'
import type { CollaborationLocale } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationWorkspace, CollaborationGroup } from '../types'
import type { CollaborationPlatformHostAdapter } from './types'
import {
  WorkspaceCollaborationGroupsConfiguration,
  type WorkspaceResourceCommands,
} from './WorkspaceResourceConfiguration'

function createTeamParticipants(api: SharedWorkspaceApi, workspaceId: string) {
  let createdGroups = false
  const resource = createAsyncResource(
    workspaceId,
    async () => {
      if (!api.workspaces) throw new Error('Workspace API is unavailable')
      const [members, agents] = await Promise.all([
        api.workspaces.listMembers(workspaceId),
        api.workspaces.listAgents(workspaceId),
      ])
      return { members, agents }
    },
    { refreshOnSubscribe: true }
  )
  return {
    ...resource,
    recordCreatedGroup() {
      createdGroups = true
    },
    takeCreatedGroups() {
      const pending = createdGroups
      createdGroups = false
      return pending
    },
  }
}

export function RootTeamEditor({
  api,
  host,
  workspace,
  groups,
  locale,
  onClose,
  onCreated,
  groupId,
}: {
  api: SharedWorkspaceApi
  host: CollaborationPlatformHostAdapter
  workspace: CollaborationWorkspace
  groups: CollaborationGroup[]
  locale: CollaborationLocale
  onClose(): void
  onCreated(): Promise<void>
  groupId?: string
}) {
  const participants = useMemo(() => createTeamParticipants(api, workspace.id), [api, workspace.id])
  const participantSnapshot = useSyncExternalStore(
    participants.subscribe,
    participants.getSnapshot,
    participants.getSnapshot
  )
  const members = participantSnapshot.data?.members ?? []
  const agents = participantSnapshot.data?.agents ?? []
  const loading = !participantSnapshot.settled
  const error =
    participantSnapshot.status === 'error'
      ? participantSnapshot.error instanceof Error
        ? participantSnapshot.error.message
        : String(participantSnapshot.error)
      : null
  const commands = useMemo<WorkspaceResourceCommands>(() => {
    if (!api.workspaces) {
      throw new Error('Workspace API is unavailable')
    }
    return {
      transferOwnership: api.workspaces.transferOwnership
        ? async (userId, version) => {
            await api.workspaces!.transferOwnership!(workspace.id, {
              userId,
              version,
            })
            if (!participants.hasSubscribers()) return
            await onCreated()
            if (participants.hasSubscribers()) onClose()
          }
        : undefined,
      searchUsers: query => api.members.searchUsers(query),
      addMember: (userId, role) => api.workspaces!.addMember(workspace.id, { userId, role }),
      updateMember: (userId, inputRole) =>
        api.workspaces!.updateMember(workspace.id, userId, {
          role: inputRole,
        }),
      removeMember: userId => api.workspaces!.removeMember(workspace.id, userId),
      async loadTemplateAgents(group) {
        const agents = await api.workspaces!.listAgents(workspace.id, {
          forceRefresh: true,
        })
        return readTemplateAgents(
          agents,
          [group],
          host.projectAgentConfiguration?.readTemplateAgent
        )
      },
      async createTemplateGroups(document, drafts, resolveRouting) {
        const created = await applyWorkspaceTemplate(
          api,
          workspace,
          document,
          drafts,
          host.projectAgentConfiguration,
          templateMessages[locale].partial,
          () => {
            participants.recordCreatedGroup()
          },
          templateMessages[locale].unsupportedPolicy,
          locale,
          resolveRouting
        )
        return created
      },
      async createCollaborationGroup(input) {
        const created = await api.workspaces!.createCollaborationGroup(workspace.id, input)
        participants.recordCreatedGroup()
        return created
      },
      async updateCollaborationGroup(groupId, input) {
        const updated = await api.workspaces!.updateCollaborationGroup(workspace.id, groupId, input)
        if (!participants.hasSubscribers()) return updated
        await onCreated()
        if (participants.hasSubscribers()) onClose()
        return updated
      },
      async removeCollaborationGroup(groupId) {
        await api.workspaces!.removeCollaborationGroup(workspace.id, groupId)
        if (!participants.hasSubscribers()) return
        await onCreated()
        if (participants.hasSubscribers()) onClose()
      },
    }
  }, [participants, api, workspace, host.projectAgentConfiguration, locale, onClose, onCreated])

  if (loading || error) {
    return (
      <div className="collaboration-dialog-backdrop" role="presentation">
        <DialogSurface
          onClose={onClose}
          render={
            <section
              className="collaboration-resource-dialog"
              aria-labelledby="root-team-editor-status-title"
            />
          }
        >
          <header>
            <div>
              <h2 id="root-team-editor-status-title">
                {groupId
                  ? locale === 'zh-CN'
                    ? '协作小组设置'
                    : 'Team settings'
                  : locale === 'zh-CN'
                    ? '新建协作小组'
                    : 'New team'}
              </h2>
              <p>
                {error ??
                  (locale === 'zh-CN'
                    ? '正在加载分组成员与智能体…'
                    : 'Loading workspace members and agents…')}
              </p>
            </div>
            <ControlButton variant="unstyled" type="button" onClick={onClose}>
              <X aria-hidden="true" />
            </ControlButton>
          </header>
        </DialogSurface>
      </div>
    )
  }

  const form = (
    <WorkspaceCollaborationGroupsConfiguration
      agentConfiguration={host.projectAgentConfiguration}
      workspace={workspace}
      groups={groups}
      members={members}
      agents={agents}
      locale={locale}
      currentUserId={host.currentUser?.id}
      commands={commands}
      agentActions={{
        ...(workspace.location === 'cloud' && host.projectAgentConfiguration?.renderAgentCreator
          ? {
              renderCreator: ({ onClose, onCreated }) =>
                host.projectAgentConfiguration!.renderAgentCreator!({
                  namespace: workspace.namespace,
                  workspaceName: workspace.name,
                  onClose,
                  onCreated: async resource => {
                    const created = await api.workspaces!.addAgent(workspace.id, {
                      teamId: resource.teamId,
                    })
                    if (!participants.hasSubscribers()) return
                    const nextAgents = await api.workspaces!.listAgents(workspace.id)
                    if (!participants.hasSubscribers()) return
                    participants.update(current =>
                      current ? { ...current, agents: nextAgents } : current
                    )
                    await onCreated(created)
                  },
                }),
            }
          : {}),
      }}
      initialCreateOpen={!groupId}
      initialSelectedGroupId={groupId}
      onDetailClose={onClose}
      detailPresentation={groupId ? 'dialog' : 'page'}
      showGroupCollection={Boolean(groupId)}
      onCreateOpenChange={open => {
        if (!groupId && !open) {
          onClose()
          if (participants.takeCreatedGroups()) {
            void onCreated()
          }
        }
      }}
    />
  )
  return groupId ? (
    <div className="collaboration-resource-dialog-backdrop">
      <DialogSurface
        onClose={onClose}
        render={
          <section
            className="collaboration-resource-dialog collaboration-team-settings-dialog"
            aria-label={locale === 'zh-CN' ? '协作小组设置' : 'Team settings'}
            data-testid="collaboration-team-settings-dialog"
          />
        }
      >
        <header className="collaboration-team-settings-header">
          <div>
            <h2>{locale === 'zh-CN' ? '设置协作小组' : 'Team settings'}</h2>
            <p>
              {locale === 'zh-CN'
                ? '编辑基本信息、成员分工和协作方式'
                : 'Edit team details, participants, and collaboration rules'}
            </p>
          </div>
          <ControlButton
            variant="unstyled"
            type="button"
            aria-label={locale === 'zh-CN' ? '关闭' : 'Close'}
            data-testid="collaboration-team-settings-close"
            onClick={onClose}
          >
            ×
          </ControlButton>
        </header>
        {form}
      </DialogSurface>
    </div>
  ) : (
    form
  )
}
