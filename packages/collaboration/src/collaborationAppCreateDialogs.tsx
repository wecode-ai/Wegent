// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from 'react'
import type { SharedWorkspaceApi } from './ports/SharedWorkspaceApi'
import { IssueCreate } from './IssueDetail'
import { ProjectCreateDialog, projectCreateLabels } from './project-create'
import { collaborationTestIds } from './testIds'
import type { CollaborationLocale } from './i18n'
import type { CollaborationHostAdapter } from './types'
import type { CollaborationWorkspaceControllerCommands } from './workspace-controller'

type IssueCreateProps = ComponentProps<typeof IssueCreate>
interface CreateDialogsInput extends Pick<
  IssueCreateProps,
  | 'allIssues'
  | 'environmentNotice'
  | 'environmentReadiness'
  | 'messages'
  | 'translate'
  | 'normalizePastedFiles'
> {
  api: SharedWorkspaceApi
  project: IssueCreateProps['project'] | null
  host: CollaborationHostAdapter
  commands: CollaborationWorkspaceControllerCommands
  locale: CollaborationLocale
  createProjectOpen: boolean
  setCreateProjectOpen(open: boolean): void
  createIssueOpen: boolean
  setCreateIssueOpen(open: boolean): void
  createIssueDefaults: IssueCreateProps['defaults']
}

export function renderCollaborationAppCreateDialogs({
  api,
  project,
  host,
  commands,
  locale,
  allIssues: issues,
  environmentNotice,
  environmentReadiness,
  messages,
  translate,
  normalizePastedFiles,
  createProjectOpen,
  setCreateProjectOpen,
  createIssueOpen,
  setCreateIssueOpen,
  createIssueDefaults,
}: CreateDialogsInput) {
  return (
    <>
      {createProjectOpen && (
        <ProjectCreateDialog
          targets={[
            {
              location: 'cloud',
              create: api.projects.create,
            },
          ]}
          defaultLocation="cloud"
          allowDingTalkAITable={host.capabilities.dingtalkAitable}
          labels={projectCreateLabels[locale]}
          testIds={{
            name: 'collaboration-project-name-input',
            description: 'collaboration-project-description-input',
            confirm: collaborationTestIds.createProjectConfirm,
          }}
          host={host.projectCreate}
          onClose={() => setCreateProjectOpen(false)}
          onCreated={created => {
            setCreateProjectOpen(false)
            host.navigate({
              projectId: created.id,
              issueId: null,
              view: 'board',
            })
          }}
        />
      )}
      {createIssueOpen && project && (
        <IssueCreate
          defaults={createIssueDefaults}
          api={api}
          project={project}
          allIssues={issues}
          environmentNotice={environmentNotice}
          environmentReadiness={environmentReadiness}
          messages={messages}
          translate={translate}
          onClose={() => setCreateIssueOpen(false)}
          onCreated={created => {
            commands.appendIssue(created)
            setCreateIssueOpen(false)
            host.navigate({
              projectId: project.id,
              issueId: created.id,
              view: createIssueDefaults?.milestoneId ? 'milestones' : 'board',
            })
          }}
          onError={() => commands.reportError(messages.saveFailed)}
          normalizePastedFiles={normalizePastedFiles}
        />
      )}
    </>
  )
}
