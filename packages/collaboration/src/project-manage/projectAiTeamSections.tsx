// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'
import type { CollaborationTranslate } from '../i18n'
import type { ProjectSettingsSection } from './ProjectSettingsShell'

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
      label: translate('todo.ai_team_members', '成员'),
      content: membersContent,
    },
    {
      id: 'groups',
      label: translate('todo.ai_team_groups', '协作团队'),
      content: groupsContent,
    },
  ]
  return pages.map(page => ({
    id: page.id,
    group,
    label: page.label,
    testId: `${testIdPrefix}-${page.id}`,
    content: (
      <div
        className="min-h-0 flex-1 px-5 py-6 text-sm"
        data-testid={`collaboration-project-${page.id}-page`}
      >
        <div className="mx-auto max-w-5xl">{page.content}</div>
      </div>
    ),
  }))
}
