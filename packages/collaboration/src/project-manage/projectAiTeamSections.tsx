// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'
import type { CollaborationTranslate } from '../i18n'
import type { ProjectSettingsSection } from './ProjectSettingsShell'
import {
  projectSettingsContentClassName,
  projectSettingsPageClassName,
} from './ProjectSettingsPage'

export function createProjectAiTeamSections({
  agentsContent,
  groupsContent,
  membersContent,
  testIdPrefix,
  translate,
}: {
  agentsContent: ReactNode
  groupsContent: ReactNode
  membersContent: ReactNode
  testIdPrefix: string
  translate: CollaborationTranslate
}): ProjectSettingsSection[] {
  const group = { id: 'ai-team', label: translate('todo.ai_team', 'AI 团队') }
  const pages = [
    {
      id: 'agents',
      label: translate('todo.project_agents', '智能体'),
      content: agentsContent,
    },
    {
      id: 'members',
      label: translate('todo.project_members', '项目成员'),
      content: membersContent,
    },
    {
      id: 'groups',
      label: translate('todo.collaboration_groups', '协作小组'),
      content: groupsContent,
    },
  ]
  return pages.map(page => ({
    id: page.id,
    group: page.id === 'members' ? undefined : group,
    label: page.label,
    testId: `${testIdPrefix}-${page.id}`,
    content: (
      <div
        className={projectSettingsPageClassName}
        data-testid={`collaboration-project-${page.id}-page`}
      >
        <div className={projectSettingsContentClassName}>{page.content}</div>
      </div>
    ),
  }))
}
