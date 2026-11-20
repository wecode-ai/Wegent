// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  PageHeader,
  ProjectCards,
  WorkspaceHome,
  WorkspaceSettings,
} from './PlatformWorkspaceViews'

import { createPlatformCreationState } from './platformCreationState'

import { Settings } from 'lucide-react'

import { type PlatformMessages } from './platformMessages'

import { ProjectCreationAction } from './ProjectCreationAction'

import { createCollaborationTranslator, type CollaborationLocale } from '../i18n'

import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'

import { ProjectAgentConfiguration } from '../project-agent-config'

import {
  CollaborationParticipantsTabs,
  ProjectExecutionEnvironments,
  ProjectSettingsShell,
} from '../project-manage'

import type { CollaborationProject, CollaborationWorkspace } from '../types'

import type {
  CollaborationPlatformHostAdapter,
  CollaborationPlatformLocation,
  CollaborationWorkspaceView,
} from './types'

import { WorkspaceGroupsPanel, WorkspaceMembersPanel } from './WorkspaceParticipantPanels'

import type { useCollaborationPlatformController } from './useCollaborationPlatformController'

type Controller = ReturnType<typeof useCollaborationPlatformController>
interface WorkspaceContentInput {
  workspace: CollaborationWorkspace
  creation: ReturnType<typeof createPlatformCreationState>
  openProject(project: CollaborationProject): void
  state: Controller['state']
  commands: Controller['commands']
  host: CollaborationPlatformHostAdapter
  api: SharedWorkspaceApi
  messages: PlatformMessages
  locale: CollaborationLocale
  translate: ReturnType<typeof createCollaborationTranslator>
  workspaceAgentConfigurationApi: SharedWorkspaceApi
  workspaceGroupCreationRequested: boolean
  setWorkspaceGroupCreationRequested(open: boolean): void
  openWorkspaceProjectCreator: ReturnType<
    typeof createPlatformCreationState
  >['openWorkspaceProjectCreator']
}
export function renderPlatformWorkspaceContent({
  workspace,
  creation,
  openProject,
  state,
  commands,
  host,
  api,
  messages,
  locale,
  translate,
  workspaceAgentConfigurationApi,
  workspaceGroupCreationRequested,
  setWorkspaceGroupCreationRequested,
  openWorkspaceProjectCreator,
}: WorkspaceContentInput) {
  let content: React.ReactNode
  const workspaceDisplayName =
    workspace.is_system_default || workspace.location === 'local'
      ? messages.defaultProjectWorkspace
      : workspace.name
  const canManageWorkspace =
    workspace.access_role === 'Owner' || workspace.access_role === 'Maintainer'
  const requestedWorkspaceSettingsView =
    host.location.workspaceView === 'settings' ||
    host.location.workspaceView === 'members' ||
    host.location.workspaceView === 'agents' ||
    host.location.workspaceView === 'collaboration-participants' ||
    host.location.workspaceView === 'collaboration-groups' ||
    host.location.workspaceView === 'execution-environments'
      ? host.location.workspaceView
      : null
  const workspaceSettingsView =
    requestedWorkspaceSettingsView === 'members' ||
    requestedWorkspaceSettingsView === 'agents' ||
    requestedWorkspaceSettingsView === 'collaboration-groups'
      ? 'collaboration-participants'
      : requestedWorkspaceSettingsView
  const initialWorkspaceParticipantTab =
    requestedWorkspaceSettingsView === 'members' && workspace.location !== 'local'
      ? 'members'
      : requestedWorkspaceSettingsView === 'collaboration-groups'
        ? 'groups'
        : 'agents'
  const usesProjectImporter = workspace.location === 'local' && Boolean(host.renderProjectImporter)
  const createProjectAction = (
    <ProjectCreationAction
      className="collaboration-primary-button inline-flex items-center gap-1.5"
      messages={messages}
      onSelect={mode => openWorkspaceProjectCreator(workspace.id, mode)}
      supportsLocalImport={usesProjectImporter}
      testId="collaboration-workspace-project-create"
    />
  )
  if (workspaceSettingsView) {
    const workspaceSettingsSections = [
      ...(canManageWorkspace
        ? [
            {
              id: 'settings',
              label: messages.basicInformation,
              testId: 'collaboration-workspace-nav-settings',
              content: (
                <div className="collaboration-platform-page collaboration-workspace-settings-page">
                  <PageHeader
                    title={messages.basicInformation}
                    subtitle={`${messages.settings} · ${workspaceDisplayName}`}
                  />
                  <WorkspaceSettings
                    workspace={workspace}
                    displayName={workspaceDisplayName}
                    messages={messages}
                    onSave={async input => {
                      await commands.updateWorkspace(input)
                      if (creation.isAccountCurrent()) host.notify?.(messages.save, 'success')
                    }}
                  />
                </div>
              ),
            },
          ]
        : []),
      {
        id: 'collaboration-participants',
        label: messages.collaborationParticipants,
        testId: 'collaboration-workspace-nav-participants',
        content: (
          <div className="collaboration-platform-page collaboration-workspace-settings-page">
            <PageHeader
              title={messages.collaborationParticipants}
              subtitle={messages.collaborationParticipantsHint}
            />
            <CollaborationParticipantsTabs
              agentsContent={
                <ProjectAgentConfiguration
                  api={workspaceAgentConfigurationApi}
                  canManage={
                    workspace.access_role === 'Owner' ||
                    workspace.access_role === 'Maintainer' ||
                    workspace.access_role === 'Developer'
                  }
                  host={host.projectAgentConfiguration}
                  project={{
                    id: workspace.id,
                    name: workspace.name,
                    namespace: workspace.namespace,
                    workspace_id: null,
                    project_store: workspace.location === 'local' ? 'local' : 'backend',
                  }}
                  onError={() => host.notify?.(messages.loadFailed, 'error')}
                  scope="workspace"
                  translate={translate}
                />
              }
              agentsLabel={messages.agents}
              ariaLabel={messages.collaborationParticipants}
              groupsContent={
                <WorkspaceGroupsPanel
                  agentConfiguration={host.projectAgentConfiguration}
                  key={workspace.id}
                  api={api}
                  workspace={workspace}
                  translate={translate}
                  locale={locale}
                  currentUserId={host.currentUser?.id}
                  commands={commands}
                  initialCreateOpen={workspaceGroupCreationRequested}
                  onCreateOpenChange={open => {
                    if (!open) setWorkspaceGroupCreationRequested(false)
                  }}
                />
              }
              groupsLabel={messages.collaborationGroups}
              initialTab={initialWorkspaceParticipantTab}
              membersContent={
                workspace.location === 'cloud' ? (
                  <WorkspaceMembersPanel
                    key={workspace.id}
                    api={api}
                    workspace={workspace}
                    translate={translate}
                    locale={locale}
                    commands={commands}
                  />
                ) : undefined
              }
              membersLabel={workspace.location === 'cloud' ? messages.members : undefined}
              testIdPrefix="collaboration-workspace-participants"
            />
          </div>
        ),
      },
      {
        id: 'execution-environments',
        label: messages.environments,
        testId: 'collaboration-workspace-nav-execution-environments',
        content: (
          <ProjectExecutionEnvironments api={api} workspace={workspace} translate={translate} />
        ),
      },
    ]
    content = (
      <ProjectSettingsShell
        pageRenderer={host.settingsPages}
        scopeKey={workspace.id}
        ariaLabel={`${messages.settings} · ${workspaceDisplayName}`}
        testId="workspace-settings-shell"
        selectedSectionId={workspaceSettingsView}
        onSectionChange={sectionId =>
          navigateWithin(host, {
            workspaceView: sectionId as CollaborationWorkspaceView,
            projectId: null,
            issueId: null,
          })
        }
        sections={workspaceSettingsSections}
      />
    )
  } else {
    content = (
      <div className="collaboration-platform-page">
        <PageHeader
          title={
            host.location.workspaceView === 'projects' ? messages.allProjects : workspaceDisplayName
          }
          subtitle={
            host.location.workspaceView === 'projects'
              ? messages.noProjectsHint
              : messages.operationsHint
          }
          action={
            <div className="collaboration-platform-page-actions">
              {host.location.workspaceView === 'home' && canManageWorkspace ? (
                <button
                  type="button"
                  className="collaboration-platform-secondary-button"
                  data-testid="collaboration-workspace-home-settings"
                  onClick={() =>
                    navigateWithin(host, {
                      workspaceView: 'settings',
                      projectId: null,
                      issueId: null,
                    })
                  }
                >
                  <Settings aria-hidden="true" />
                  {messages.settings}
                </button>
              ) : null}
              {createProjectAction}
            </div>
          }
        />
        {host.location.workspaceView === 'home' ? (
          state.projects.length === 0 ? (
            <section
              className="collaboration-workspace-starter"
              data-testid="collaboration-workspace-starter"
            >
              <h2>{messages.firstProjectTitle}</h2>
              <p>{messages.firstProjectHint}</p>
              <div>
                <ProjectCreationAction
                  className="collaboration-primary-button"
                  messages={messages}
                  onSelect={mode => openWorkspaceProjectCreator(workspace.id, mode)}
                  supportsLocalImport={usesProjectImporter}
                  testId="collaboration-workspace-starter-create-project"
                />
                <button
                  type="button"
                  className="collaboration-platform-secondary-button"
                  data-testid="collaboration-workspace-starter-configure-agents"
                  onClick={() =>
                    navigateWithin(host, {
                      workspaceView: 'collaboration-participants',
                      projectId: null,
                      issueId: null,
                    })
                  }
                >
                  {messages.configureAgents}
                </button>
                {workspace.location === 'cloud' ? (
                  <button
                    type="button"
                    className="collaboration-platform-secondary-button"
                    data-testid="collaboration-workspace-starter-invite-members"
                    onClick={() =>
                      navigateWithin(host, {
                        workspaceView: 'members',
                        projectId: null,
                        issueId: null,
                      })
                    }
                  >
                    {messages.inviteMembers}
                  </button>
                ) : null}
              </div>
            </section>
          ) : (
            <WorkspaceHome
              projects={state.projects}
              projectIssues={state.projectIssues}
              locale={locale}
              messages={messages}
              onOpenProject={openProject}
              onOpenProjects={() =>
                navigateWithin(host, {
                  workspaceView: 'projects',
                  projectId: null,
                  issueId: null,
                })
              }
              onOpenIssue={(project, issue) =>
                navigateWithin(host, {
                  workspaceView: 'projects',
                  projectId: project.id,
                  projectView: 'board',
                  issueId: issue.id,
                })
              }
            />
          )
        ) : null}
        {host.location.workspaceView === 'projects' ? (
          <section className="collaboration-platform-panel">
            <h2>{messages.projects}</h2>
            <ProjectCards projects={state.projects} messages={messages} onOpen={openProject} />
          </section>
        ) : null}
      </div>
    )
  }

  return content
}

function navigateWithin(
  host: CollaborationPlatformHostAdapter,
  patch: Partial<CollaborationPlatformLocation>
) {
  const location = { ...host.location, ...patch }
  if (patch.projectView && patch.projectView !== 'manage') location.projectSettingsSection = null
  host.navigate(location)
}
