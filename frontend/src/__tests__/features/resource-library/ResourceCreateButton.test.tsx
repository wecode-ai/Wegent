// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ResourceCreateButton } from '@/features/resource-library/components/ResourceCreateButton'
import type { Group } from '@/types/group'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'actions.create_to_personal': 'Create in My Resources',
        'actions.create_to_group': `Create in ${options?.group}`,
        'actions.choose_create_target': 'Create Location',
        'actions.choose_create_target_description':
          'Select whether to create this resource in your resources or a team.',
        'actions.cancel': 'Cancel',
        'targets.personal': 'My Resources',
        'targets.personal_description': 'Only you can see and manage it.',
        'targets.personal_section': 'Personal',
        'targets.group_description': 'Team members can see it and manage it by team permissions.',
        'targets.group_section': 'Team',
        'targets.select': 'Select',
        'search.groups_placeholder': 'Search teams',
        'search.groups_empty': 'No matching teams',
        'resource-library:actions.create_to_personal': 'Create in My Resources',
        'resource-library:actions.create_to_group': `Create in ${options?.group}`,
      }
      return translations[key] ?? key
    },
  }),
}))

const groups: Group[] = [
  {
    id: 1,
    name: 'platform',
    display_name: 'Platform',
    parent_name: null,
    owner_user_id: 1,
    description: '',
    visibility: 'private',
    level: 'group',
    is_active: true,
    my_role: 'Owner',
    member_count: 1,
    created_at: '2026-05-28T00:00:00',
    updated_at: '2026-05-28T00:00:00',
  },
  {
    id: 2,
    name: 'design',
    display_name: 'Design',
    parent_name: null,
    owner_user_id: 1,
    description: '',
    visibility: 'private',
    level: 'group',
    is_active: true,
    my_role: 'Maintainer',
    member_count: 1,
    created_at: '2026-05-28T00:00:00',
    updated_at: '2026-05-28T00:00:00',
  },
]

describe('ResourceCreateButton', () => {
  it('opens a target picker dialog when creating from the all source filter', async () => {
    const onCreate = jest.fn()
    const user = userEvent.setup()

    render(
      <ResourceCreateButton
        label="Create"
        scope="all"
        sourceFilter="all"
        groups={groups}
        onCreate={onCreate}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByRole('dialog', { name: 'Create Location' })).toBeInTheDocument()
    expect(
      screen.getByText('Select whether to create this resource in your resources or a team.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /My Resources/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Platform/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Design/ })).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('Search teams'), 'plat')
    expect(screen.queryByRole('button', { name: /Design/ })).not.toBeInTheDocument()

    await user.click(screen.getByTestId('resource-create-button-group-option-platform'))
    expect(onCreate).toHaveBeenCalledWith({ scope: 'group', groupName: 'platform' })
  })

  it('creates directly in personal scope when source is personal', async () => {
    const onCreate = jest.fn()
    const user = userEvent.setup()

    render(
      <ResourceCreateButton
        label="Create"
        scope="personal"
        sourceFilter="personal"
        groups={groups}
        onCreate={onCreate}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onCreate).toHaveBeenCalledWith({ scope: 'personal' })
  })

  it('hides the create action for system source', () => {
    render(
      <ResourceCreateButton
        label="Create"
        scope="all"
        sourceFilter="system"
        groups={groups}
        onCreate={jest.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument()
  })
})
