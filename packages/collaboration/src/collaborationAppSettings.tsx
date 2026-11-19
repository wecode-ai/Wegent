// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  collaborationMessages,
  createCollaborationTranslator,
  CollaborationLocale,
} from './i18n'
import type {
  CollaborationProject,
  CollaborationHostAdapter,
  ProjectSettingsSectionId,
} from './types'
import type { SharedWorkspaceApi } from './ports/SharedWorkspaceApi'
import type { CollaborationWorkspaceController } from './workspace-controller'
import { CollaborationSettings } from './CollaborationSettings'
import { ProjectTemplateSettings } from './templates/ProjectTemplateSettings'
import type { useCollaborationTemplateStore } from './templates/context'
import { templateMessages } from './templates/messages'
import {
  createProjectParticipantSections,
  projectAiSettingsGroup,
  ProjectCollaborationGroups,
  ProjectAutomaticProcessing,
  ProjectExecutionEnvironments,
  ProjectSettingsShell,
} from './project-manage'

interface SettingsInput {
  api: SharedWorkspaceApi
  project: CollaborationProject
  host: CollaborationHostAdapter
  locale: CollaborationLocale
  messages: (typeof collaborationMessages)[keyof typeof collaborationMessages]
  translate: ReturnType<typeof createCollaborationTranslator>
  templateStore: ReturnType<typeof useCollaborationTemplateStore>
  members: CollaborationWorkspaceController['state']['members']
  agents: CollaborationWorkspaceController['state']['agents']
  commands: CollaborationWorkspaceController['commands']
  settingsSectionId: ProjectSettingsSectionId
  setSettingsSectionId(section: ProjectSettingsSectionId): void
  onProjectChange?(project: CollaborationProject): void
}

export function renderCollaborationAppSettings({
  api,
  project,
  host,
  locale,
  messages,
  translate,
  templateStore,
  members,
  agents,
  commands,
  settingsSectionId,
  setSettingsSectionId,
  onProjectChange,
}: SettingsInput) {
  return (
    <ProjectSettingsShell
      pageRenderer={host.settingsPages}
      scopeKey={`${project.project_store}:${project.id}`}
      ariaLabel={messages.settings}
      onSectionChange={sectionId => {
        const nextSectionId = sectionId as ProjectSettingsSectionId
        setSettingsSectionId(nextSectionId)
        host.navigate({
          projectId: project.id,
          issueId: null,
          view: 'manage',
          projectSettingsSection: nextSectionId,
        })
      }}
      selectedSectionId={settingsSectionId}
      sections={[
        {
          id: 'project',
          label: messages.projectConfiguration,
          testId: 'collaboration-project-settings-project',
          content: (
            <CollaborationSettings
              api={api}
              key={project.id}
              project={project}
              onChange={commands.replaceProject}
              onError={() => commands.reportError(messages.saveFailed)}
              translate={translate}
              section="overview"
            />
          ),
        },
        ...(templateStore
          ? [
              {
                id: 'configuration-sharing',
                label: templateMessages[locale].configuration,
                testId: 'collaboration-project-settings-sharing',
                content: (
                  <ProjectTemplateSettings
                    agentConfiguration={host.projectAgentConfiguration}
                    key={project.id}
                    onChange={commands.replaceProject}
                    api={api}
                    project={project}
                    locale={locale}
                    currentUserId={templateStore.library.ownerId}
                    canManage={
                      project.access_role === 'Owner' || project.access_role === 'Maintainer'
                    }
                  />
                ),
              },
            ]
          : []),
        ...createProjectParticipantSections({
          translate: translate,
          membersContent: (
            <CollaborationSettings
              api={api}
              embedded
              project={project}
              onChange={commands.replaceProject}
              onError={() => commands.reportError(messages.saveFailed)}
              translate={translate}
              section="members"
            />
          ),
          agentsContent: (
            <CollaborationSettings
              agentConfigurationHost={host.projectAgentConfiguration}
              agentResourceContext={host.projectAgentResourceContext}
              api={api}
              embedded
              project={project}
              onChange={commands.replaceProject}
              onError={() => commands.reportError(messages.saveFailed)}
              onAgentsChange={() => void commands.refreshProjectAgents(project.id)}
              translate={translate}
              section="agents"
            />
          ),
          groupsContent: api.projects.listCollaborationGroups ? (
            <ProjectCollaborationGroups
              agentConfiguration={host.projectAgentConfiguration}
              agentResourceContext={host.projectAgentResourceContext}
              location={project.project_store === 'local' ? 'local' : 'cloud'}
              onProjectChanged={commands.replaceProject}
              api={api}
              currentUserId={templateStore?.library.ownerId}
              projectId={project.id}
              workspaceId={project.workspace_id}
              locale={locale}
              members={members}
              agents={agents}
              canManage={project.access_role === 'Owner' || project.access_role === 'Maintainer'}
            />
          ) : (
            <div
              className="rounded-xl border border-border bg-surface-subtle px-5 py-4 text-sm text-text-muted"
              data-testid="collaboration-project-groups-unavailable"
            >
              {translate(
                'todo.collaboration_groups_unavailable_description',
                '协作小组服务当前不可用。'
              )}
            </div>
          ),
          testIdPrefix: 'collaboration-project-settings',
        }),
        {
          id: 'environments',
          group: projectAiSettingsGroup(translate),
          label: messages.projectEnvironments,
          testId: 'collaboration-project-settings-environments',
          content: (
            <ProjectExecutionEnvironments
              api={api}
              onManageDevices={
                host.manageResource ? () => host.manageResource?.('environments') : undefined
              }
              onProjectChange={nextProject => {
                commands.replaceProject(nextProject)
                onProjectChange?.(nextProject)
              }}
              project={project}
              translate={translate}
            />
          ),
        },
        ...(host.capabilities.automation && api.automations
          ? [
              {
                id: 'automatic-processing',
                label: messages.automaticProcessing,
                testId: 'collaboration-project-settings-automatic-processing',
                content: (
                  <ProjectAutomaticProcessing
                    onProjectChange={commands.replaceProject}
                    api={api}
                    project={project}
                    members={members}
                    agents={agents}
                    locale={locale}
                    translate={translate}
                  />
                ),
              },
            ]
          : []),
      ]}
    />
  )
}
