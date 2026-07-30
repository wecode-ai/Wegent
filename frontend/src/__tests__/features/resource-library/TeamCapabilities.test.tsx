// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'

import { listGroups } from '@/apis/groups'
import { TeamCapabilities } from '@/features/resource-library/components/TeamCapabilities'

jest.mock('@/apis/groups', () => ({
  listGroups: jest.fn(),
}))

jest.mock('@/features/resource-library/components/MyResources', () => ({
  MyResources: ({
    allowedTypes,
    hideTypeControls,
    groupFilter,
    leadingFilterControls,
    modelCategoryFilter,
    hideModelCategoryFilter,
  }: {
    allowedTypes: string[]
    hideTypeControls?: boolean
    groupFilter?: string[]
    leadingFilterControls?: ReactNode
    modelCategoryFilter?: string
    hideModelCategoryFilter?: boolean
  }) => (
    <div
      data-testid="team-resource-manager"
      data-types={allowedTypes.join(',')}
      data-hide-type-controls={hideTypeControls ? 'true' : 'false'}
      data-group-filter={groupFilter?.join(',') || ''}
      data-model-category-filter={modelCategoryFilter ?? ''}
      data-hide-model-category-filter={hideModelCategoryFilter ? 'true' : 'false'}
    >
      {leadingFilterControls}
    </div>
  ),
}))

jest.mock('@/features/resource-library/components/DiscoverResources', () => ({
  DiscoverResources: ({ leadingFilterControls }: { leadingFilterControls?: ReactNode }) => (
    <div data-testid="team-discover-resources">{leadingFilterControls}</div>
  ),
}))

jest.mock('@/features/resource-library/components/GroupInstalledSkills', () => ({
  GroupInstalledSkills: () => <div data-testid="group-installed-skills" />,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'states.no_groups': '暂无组资源',
        'states.select_groups': '请选择至少一个团队',
        'fields.team_scope': '团队范围',
        'sources.all_groups': '全部团队',
        'sources.selected_groups': '已选择多个团队',
        'search.groups_placeholder': '搜索团队',
        'search.groups_empty': '没有匹配的团队',
        'actions.view_capabilities': '查看能力',
        'actions.add_capability': '从市场添加',
        'messages.group_manage_required': '需要群组开发者或更高权限',
      })[key] || key,
  }),
}))

const mockedListGroups = listGroups as jest.MockedFunction<typeof listGroups>

function makeGroup(
  id: number,
  name: string,
  displayName: string,
  role: 'Developer' | 'Reporter' = 'Developer'
) {
  return {
    id,
    name,
    display_name: displayName,
    parent_name: null,
    owner_user_id: 1,
    visibility: 'private' as const,
    level: 'group' as const,
    description: null,
    is_active: true,
    my_role: role,
    created_at: '2026-07-16T00:00:00Z',
    updated_at: '2026-07-16T00:00:00Z',
  }
}

describe('TeamCapabilities', () => {
  beforeEach(() => {
    mockedListGroups.mockResolvedValue({
      items: [makeGroup(1, 'platform', 'Platform')],
      total: 1,
    })
  })

  it('uses the top resource filter without rendering a second type navigation', async () => {
    const user = userEvent.setup()
    render(<TeamCapabilities resourceType="agent" />)

    await waitFor(() => expect(screen.getByTestId('team-resource-manager')).toBeInTheDocument())
    expect(screen.getByTestId('team-resource-manager')).toHaveAttribute('data-types', 'agent')
    expect(screen.getByTestId('team-resource-manager')).toHaveAttribute(
      'data-hide-type-controls',
      'true'
    )
    expect(screen.getByTestId('team-capability-add-button')).toBeInTheDocument()
    expect(screen.getByTestId('team-capability-toolbar')).not.toHaveClass(
      'rounded-lg',
      'bg-muted/40',
      'border-border',
      'bg-surface'
    )
    expect(screen.getByTestId('team-capability-mode-switch')).toHaveTextContent('从市场添加')
    expect(
      screen
        .getByTestId('team-capability-toolbar')
        .querySelector('[data-testid="team-capability-scope-control"]')
    ).toBeInTheDocument()
    expect(screen.getByTestId('team-capability-current-button')).toHaveAttribute(
      'data-state',
      'active'
    )
    expect(screen.getByTestId('team-capability-current-button')).toHaveClass(
      'text-base',
      'font-semibold'
    )
    expect(screen.getByTestId('team-capability-add-button')).toHaveClass('text-text-secondary')
    expect(screen.getByTestId('team-capability-current-button')).not.toHaveClass('bg-primary')
    expect(screen.getByTestId('team-capability-group-filter')).toHaveTextContent('全部团队')
    expect(
      screen
        .getByTestId('team-resource-manager')
        .querySelector('[data-testid="team-capability-scope-control"]')
    ).not.toBeInTheDocument()
    await user.click(screen.getByTestId('team-capability-group-filter'))
    expect(screen.getByTestId('team-capability-group-all')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('team-capability-group-platform')).toHaveAttribute(
      'data-state',
      'unchecked'
    )

    await user.click(screen.getByTestId('team-capability-group-platform'))

    expect(screen.getByTestId('team-capability-group-all')).toHaveAttribute(
      'data-state',
      'unchecked'
    )
    expect(screen.getByTestId('team-capability-group-platform')).toHaveAttribute(
      'data-state',
      'checked'
    )
    expect(screen.getByTestId('team-capability-group-filter')).toHaveTextContent('Platform')
  })

  it('does not offer marketplace add for foundation resource types', async () => {
    render(
      <TeamCapabilities resourceType="model" modelCategoryFilter="embedding" hideGlobalControls />
    )

    await waitFor(() => expect(screen.getByTestId('team-resource-manager')).toBeInTheDocument())
    expect(screen.getByTestId('team-resource-manager')).toHaveAttribute('data-types', 'model')
    expect(screen.queryByTestId('team-capability-add-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('team-capability-mode-switch')).not.toBeInTheDocument()
    expect(screen.getByTestId('team-resource-manager')).toHaveAttribute(
      'data-model-category-filter',
      'embedding'
    )
    expect(screen.getByTestId('team-resource-manager')).toHaveAttribute(
      'data-hide-model-category-filter',
      'true'
    )
  })

  it('shows only the unified installed skill cards for team skills', async () => {
    render(<TeamCapabilities resourceType="skill" />)

    expect(await screen.findByTestId('group-installed-skills')).toBeInTheDocument()
    expect(screen.queryByTestId('team-resource-manager')).not.toBeInTheDocument()
  })

  it('closes the team menu after the pointer leaves', async () => {
    render(<TeamCapabilities resourceType="agent" />)

    const trigger = await screen.findByTestId('team-capability-group-filter')
    fireEvent.mouseEnter(trigger)
    expect(await screen.findByTestId('team-capability-group-all')).toBeInTheDocument()

    fireEvent.mouseLeave(trigger)

    await waitFor(() => expect(screen.queryByTestId('team-capability-group-all')).toBeNull(), {
      timeout: 500,
    })
  })

  it('keeps the trigger interactive while the hover menu is open', async () => {
    render(<TeamCapabilities resourceType="agent" />)

    const trigger = await screen.findByTestId('team-capability-group-filter')
    fireEvent.mouseEnter(trigger)
    expect(await screen.findByTestId('team-capability-group-all')).toBeInTheDocument()

    expect(document.body.style.pointerEvents).not.toBe('none')
  })

  it('filters the capability list by multiple selected teams', async () => {
    const user = userEvent.setup()
    mockedListGroups.mockResolvedValue({
      items: [
        makeGroup(1, 'platform', 'Platform'),
        makeGroup(2, 'design', 'Design'),
        makeGroup(3, 'operations', 'Operations'),
      ],
      total: 3,
    })

    render(<TeamCapabilities resourceType="agent" />)

    const manager = await screen.findByTestId('team-resource-manager')
    expect(manager).toHaveAttribute('data-group-filter', '')
    await user.click(screen.getByTestId('team-capability-group-filter'))
    await user.click(screen.getByTestId('team-capability-group-platform'))
    await user.click(screen.getByTestId('team-capability-group-operations'))

    await waitFor(() =>
      expect(screen.getByTestId('team-resource-manager')).toHaveAttribute(
        'data-group-filter',
        'platform,operations'
      )
    )
    expect(screen.getByTestId('team-capability-group-filter')).toHaveTextContent('已选择多个团队')
  })

  it('uses a single writable team as the add target after multi-team filtering', async () => {
    const user = userEvent.setup()
    mockedListGroups.mockResolvedValue({
      items: [makeGroup(1, 'platform', 'Platform'), makeGroup(2, 'design', 'Design')],
      total: 2,
    })

    render(<TeamCapabilities resourceType="agent" />)

    await screen.findByTestId('team-resource-manager')
    await user.click(screen.getByTestId('team-capability-add-button'))

    const targetSelector = screen.getByTestId('team-capability-add-target')
    expect(targetSelector).toHaveTextContent('Platform')
    await user.click(targetSelector)
    await user.click(screen.getByTestId('team-capability-add-target-design'))
    expect(targetSelector).toHaveTextContent('Design')
    expect(screen.getByTestId('team-discover-resources')).toBeInTheDocument()
    expect(
      screen
        .getByTestId('team-capability-toolbar')
        .querySelector('[data-testid="team-capability-add-target-control"]')
    ).toBeInTheDocument()
    expect(screen.getByTestId('team-capability-add-button')).toHaveAttribute('data-state', 'active')
    expect(screen.getByTestId('team-capability-add-button')).not.toHaveClass('bg-primary')
    expect(screen.getByTestId('team-capability-current-button')).toHaveTextContent('查看能力')
  })

  it('shows the add permission explanation only in a tooltip', async () => {
    const user = userEvent.setup()
    mockedListGroups.mockResolvedValue({
      items: [makeGroup(1, 'platform', 'Platform', 'Reporter')],
      total: 1,
    })

    render(<TeamCapabilities resourceType="agent" />)

    const addButton = await screen.findByTestId('team-capability-add-button')
    expect(addButton).toBeDisabled()
    expect(screen.queryByText('需要群组开发者或更高权限')).not.toBeInTheDocument()

    await user.hover(addButton.parentElement!)

    expect((await screen.findAllByText('需要群组开发者或更高权限')).length).toBeGreaterThan(0)
  })
})
