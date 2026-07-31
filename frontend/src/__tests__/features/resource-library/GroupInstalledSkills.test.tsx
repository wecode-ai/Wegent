// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { removeSkillFromGroup } from '@/apis/skills'
import { GroupInstalledSkills } from '@/features/resource-library/components/GroupInstalledSkills'
import type { ResourceLibraryInstall } from '@/features/resource-library/types'
import type { Group } from '@/types/group'

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    listGroupInstalls: jest.fn(),
  },
}))

jest.mock('@/apis/skills', () => ({
  removeSkillFromGroup: jest.fn(),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      ({
        'fields.group_added_skills': '团队已添加技能',
        'filters.skill': '技能',
        'actions.more': '更多操作',
        'actions.remove_from_team': '从团队移除',
        'actions.cancel': '取消',
        'messages.remove_from_team_success': '已从团队移除技能',
        'messages.remove_from_team_failed': '从团队移除技能失败',
        'messages.remove_from_team_confirm': `从 ${values?.group} 移除 ${values?.skill}`,
      })[key] || key,
  }),
}))

jest.mock('@/components/ui/dropdown', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    onSelect,
    ...props
  }: {
    children: ReactNode
    onSelect?: () => void
  }) => (
    <button type="button" onClick={onSelect} {...props}>
      {children}
    </button>
  ),
}))

jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({
    children,
    onClick,
    ...props
  }: {
    children: ReactNode
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  }) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
}))

const mockedListGroupInstalls = resourceLibraryApi.listGroupInstalls as jest.MockedFunction<
  typeof resourceLibraryApi.listGroupInstalls
>
const mockedRemoveSkillFromGroup = removeSkillFromGroup as jest.MockedFunction<
  typeof removeSkillFromGroup
>

function makeGroup(role: 'Developer' | 'Reporter'): Group {
  return {
    id: 1,
    name: 'platform/team',
    display_name: 'Platform',
    parent_name: null,
    owner_user_id: 1,
    visibility: 'private',
    description: null,
    is_active: true,
    my_role: role,
    created_at: '2026-07-29T00:00:00Z',
    updated_at: '2026-07-29T00:00:00Z',
  }
}

function makeInstall(): ResourceLibraryInstall {
  return {
    id: 21,
    listing_id: 92,
    version_id: 1,
    user_id: 1,
    resource_type: 'skill',
    listing: {
      id: 92,
      resource_type: 'skill',
      name: 'test-skill',
      display_name: 'Test Skill',
      tags: [],
      publisher_user_id: 2,
      publisher_user_name: 'publisher-user',
      status: 'published',
      install_count: 0,
      is_installed: true,
      bind_modes: [],
      created_at: '2026-07-29T00:00:00Z',
      updated_at: '2026-07-29T00:00:00Z',
    },
    installed_reference: { skill_id: 92 },
    install_status: 'installed',
    installed_at: '2026-07-29T00:00:00Z',
    updated_at: '2026-07-29T00:00:00Z',
  }
}

describe('GroupInstalledSkills', () => {
  beforeEach(() => {
    mockedListGroupInstalls.mockResolvedValue({
      items: [makeInstall()],
      total: 1,
      page: 1,
      limit: 100,
    })
    mockedRemoveSkillFromGroup.mockResolvedValue()
  })

  it('lets a group developer remove only the group binding', async () => {
    const user = userEvent.setup()
    render(
      <GroupInstalledSkills groupNamespaces={['platform/team']} groups={[makeGroup('Developer')]} />
    )

    expect(await screen.findByText('Test Skill')).toBeInTheDocument()
    expect(screen.getByTestId('group-installed-skill-footer-21')).toHaveTextContent(
      'publisher-user2026-07-29'
    )
    await user.click(screen.getByTestId('group-skill-remove-21'))
    await user.click(screen.getByTestId('confirm-remove-group-skill'))

    await waitFor(() =>
      expect(mockedRemoveSkillFromGroup).toHaveBeenCalledWith(92, 'platform/team')
    )
    expect(screen.queryByText('Test Skill')).not.toBeInTheDocument()
  })

  it('does not show removal actions to a regular group member', async () => {
    render(
      <GroupInstalledSkills groupNamespaces={['platform/team']} groups={[makeGroup('Reporter')]} />
    )

    expect(await screen.findByText('Test Skill')).toBeInTheDocument()
    expect(screen.queryByTestId('group-skill-actions-21')).not.toBeInTheDocument()
  })
})
