// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { listGroups } from '@/apis/groups'
import { MyResources } from '@/features/resource-library/components/MyResources'

const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  usePathname: () => '/resource-library',
  useRouter: () => ({
    replace: mockReplace,
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

jest.mock('@/apis/groups', () => ({
  listGroups: jest.fn(),
}))

jest.mock('@/features/settings/components/TeamListWithScope', () => ({
  TeamListWithScope: ({
    scope,
    selectedGroup,
    sourceControls,
  }: {
    scope: string
    selectedGroup?: string | null
    sourceControls?: React.ReactNode
  }) => (
    <div data-testid="agent-resource-manager" data-scope={scope} data-group={selectedGroup ?? ''}>
      {sourceControls}
    </div>
  ),
}))

jest.mock('@/features/settings/components/ModelListWithScope', () => ({
  ModelListWithScope: ({
    scope,
    selectedGroup,
    sourceControls,
  }: {
    scope: string
    selectedGroup?: string | null
    sourceControls?: React.ReactNode
  }) => (
    <div data-testid="model-resource-manager" data-scope={scope} data-group={selectedGroup ?? ''}>
      {sourceControls}
    </div>
  ),
}))

jest.mock('@/features/settings/components/ShellListWithScope', () => ({
  ShellListWithScope: ({
    scope,
    selectedGroup,
    sourceControls,
  }: {
    scope: string
    selectedGroup?: string | null
    sourceControls?: React.ReactNode
  }) => (
    <div data-testid="shell-resource-manager" data-scope={scope} data-group={selectedGroup ?? ''}>
      {sourceControls}
    </div>
  ),
}))

jest.mock('@/features/settings/components/SkillListWithScope', () => ({
  SkillListWithScope: ({
    scope,
    selectedGroup,
    sourceControls,
  }: {
    scope: string
    selectedGroup?: string | null
    sourceControls?: React.ReactNode
  }) => (
    <div data-testid="skill-resource-manager" data-scope={scope} data-group={selectedGroup ?? ''}>
      {sourceControls}
    </div>
  ),
}))

jest.mock('@/features/settings/components/RetrieverListWithScope', () => ({
  RetrieverListWithScope: ({
    scope,
    selectedGroup,
    sourceControls,
  }: {
    scope: string
    selectedGroup?: string | null
    sourceControls?: React.ReactNode
  }) => (
    <div
      data-testid="retriever-resource-manager"
      data-scope={scope}
      data-group={selectedGroup ?? ''}
    >
      {sourceControls}
    </div>
  ),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'filters.agent': '智能体',
        'filters.model': '模型',
        'filters.shell': '执行器',
        'filters.skill': '技能',
        'filters.retriever': '检索器',
        'sources.all': '全部',
        'sources.personal': '我创建的',
        'sources.group': '团队',
        'sources.system': '系统',
        'sources.all_groups': '全部团队',
        'actions.manage_groups': '管理...',
        'fields.source': '来源',
        'states.no_groups': '暂无组资源',
        'search.groups_placeholder': '搜索团队',
        'search.groups_empty': '没有匹配的团队',
      }

      return translations[key] ?? translations[key.replace(/^resource-library:/, '')] ?? key
    },
  }),
}))

const mockListGroups = listGroups as jest.MockedFunction<typeof listGroups>

async function openGroupMenu() {
  const user = userEvent.setup()
  const groupSelect = screen.getByTestId('resource-source-group-button')
  await user.click(groupSelect)
  return groupSelect
}

function makeGroup(overrides: Partial<Awaited<ReturnType<typeof listGroups>>['items'][number]>) {
  return {
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
    ...overrides,
  } as Awaited<ReturnType<typeof listGroups>>['items'][number]
}

describe('MyResources', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.history.replaceState({}, '', '/resource-library')
    mockListGroups.mockResolvedValue({
      items: [
        makeGroup({
          id: 1,
          name: 'platform',
          display_name: 'Platform',
        }),
      ],
      total: 1,
    })
  })

  it('renders the personal agent manager by default', async () => {
    render(<MyResources title="资源库" />)

    expect(await screen.findByTestId('agent-resource-manager')).toHaveAttribute('data-scope', 'all')
    const header = screen.getByTestId('managed-resource-header')
    expect(within(header).getByRole('heading', { name: '资源库' })).toBeInTheDocument()
    expect(within(header).getByTestId('managed-resource-type-tabs')).toBeInTheDocument()
    expect(screen.getByTestId('managed-resource-agent-tab')).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen
        .getAllByRole('button')
        .filter(button => button.dataset.testid?.startsWith('managed-resource-'))
        .map(button => button.textContent)
    ).toEqual(['智能体', '技能', '模型', '执行器', '检索器'])
    expect(screen.queryByRole('button', { name: 'MCP' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('managed-resource-mcp-tab')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resource-scope-group-button')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '组管理' })).not.toBeInTheDocument()

    const sourceFilter = screen.getByTestId('managed-resource-source-filter')
    expect(within(sourceFilter).getByTestId('resource-source-all-button')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(within(sourceFilter).getByTestId('resource-source-personal-button')).toBeInTheDocument()
    expect(within(sourceFilter).getByTestId('resource-source-group-button')).toBeInTheDocument()
    expect(within(sourceFilter).getByTestId('resource-source-system-button')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

    await openGroupMenu()
    expect(await screen.findByRole('menuitem', { name: '全部团队' })).toBeInTheDocument()
    expect(await screen.findByRole('menuitem', { name: 'Platform' })).toBeInTheDocument()
  })

  it('sorts team source options by display name', async () => {
    mockListGroups.mockResolvedValue({
      items: [
        makeGroup({ id: 1, name: 'zeta', display_name: 'Zeta Team' }),
        makeGroup({ id: 2, name: 'alpha', display_name: 'Alpha Team' }),
        makeGroup({ id: 3, name: 'beta', display_name: 'Beta Team' }),
      ],
      total: 3,
    })

    render(<MyResources />)

    await waitFor(() => expect(mockListGroups).toHaveBeenCalled())
    await openGroupMenu()

    const menu = await screen.findByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map(item => item.textContent)
    ).toEqual(['全部团队', 'Alpha Team', 'Beta Team', 'Zeta Team'])
  })

  it('filters team source options by entered text', async () => {
    const user = userEvent.setup()
    mockListGroups.mockResolvedValue({
      items: [
        makeGroup({ id: 1, name: 'zeta', display_name: 'Zeta Team' }),
        makeGroup({ id: 2, name: 'ops-core', display_name: 'Core Team' }),
        makeGroup({ id: 3, name: 'beta', display_name: 'Beta Team' }),
      ],
      total: 3,
    })

    render(<MyResources />)

    await waitFor(() => expect(mockListGroups).toHaveBeenCalled())
    await openGroupMenu()
    await user.type(screen.getByTestId('resource-source-group-search-input'), 'ops')

    expect(screen.getByRole('menuitem', { name: '全部团队' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Core Team' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Beta Team' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Zeta Team' })).not.toBeInTheDocument()

    await user.clear(screen.getByTestId('resource-source-group-search-input'))
    await user.type(screen.getByTestId('resource-source-group-search-input'), 'missing')

    expect(screen.getByRole('menuitem', { name: '全部团队' })).toBeInTheDocument()
    expect(screen.getByText('没有匹配的团队')).toBeInTheDocument()
  })

  it('keeps resource type as the primary navigation and source as a secondary filter', async () => {
    render(<MyResources />)

    const typeTabs = await screen.findByTestId('managed-resource-type-tabs')
    expect(within(typeTabs).getByTestId('managed-resource-agent-tab')).toBeInTheDocument()
    expect(within(typeTabs).getByTestId('managed-resource-skill-tab')).toBeInTheDocument()
    expect(within(typeTabs).queryByTestId('resource-source-group-button')).not.toBeInTheDocument()

    const sourceFilter = screen.getByTestId('managed-resource-source-filter')
    expect(within(sourceFilter).getByText('来源')).toBeInTheDocument()
    expect(within(sourceFilter).getByTestId('resource-source-all-button')).toBeInTheDocument()
    expect(within(sourceFilter).getByTestId('resource-source-personal-button')).toBeInTheDocument()
    expect(within(sourceFilter).getByTestId('resource-source-group-button')).toBeInTheDocument()
    expect(within(sourceFilter).getByTestId('resource-source-system-button')).toBeInTheDocument()
  })

  it('switches between managed resource types', async () => {
    render(<MyResources />)

    expect(await screen.findByTestId('agent-resource-manager')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('managed-resource-model-tab'))
    expect(await screen.findByTestId('model-resource-manager')).toHaveAttribute('data-scope', 'all')

    fireEvent.click(screen.getByTestId('managed-resource-shell-tab'))
    expect(await screen.findByTestId('shell-resource-manager')).toHaveAttribute('data-scope', 'all')

    fireEvent.click(screen.getByTestId('managed-resource-skill-tab'))
    expect(await screen.findByTestId('skill-resource-manager')).toHaveAttribute('data-scope', 'all')

    fireEvent.click(screen.getByTestId('managed-resource-retriever-tab'))
    expect(await screen.findByTestId('retriever-resource-manager')).toHaveAttribute(
      'data-scope',
      'all'
    )
  })

  it('opens the managed resource type from the URL query', async () => {
    window.history.replaceState({}, '', '/resource-library?tab=mine&type=skill&scope=personal')

    render(<MyResources />)

    expect(await screen.findByTestId('skill-resource-manager')).toHaveAttribute(
      'data-scope',
      'personal'
    )
    expect(screen.getByTestId('managed-resource-skill-tab')).toHaveAttribute('aria-pressed', 'true')
  })

  it('updates the URL query when switching managed resource types', async () => {
    window.history.replaceState({}, '', '/resource-library?tab=mine&type=agent&scope=personal')
    render(<MyResources />)

    fireEvent.click(await screen.findByTestId('managed-resource-skill-tab'))

    expect(mockReplace).toHaveBeenCalledWith(
      '/resource-library?tab=mine&type=skill&scope=personal',
      { scroll: false }
    )
  })

  it('filters to all groups or a selected group from the team source dropdown', async () => {
    render(<MyResources />)

    await waitFor(() => expect(mockListGroups).toHaveBeenCalled())
    await openGroupMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: '全部团队' }))

    await waitFor(() =>
      expect(screen.getByTestId('agent-resource-manager')).toHaveAttribute('data-scope', 'group')
    )
    expect(screen.getByTestId('agent-resource-manager')).toHaveAttribute('data-group', '')

    await openGroupMenu()
    const platformOption = await screen.findByRole('menuitem', { name: 'Platform' })

    fireEvent.click(platformOption)
    await waitFor(() =>
      expect(screen.getByTestId('agent-resource-manager')).toHaveAttribute('data-scope', 'group')
    )
    expect(screen.getByTestId('agent-resource-manager')).toHaveAttribute('data-group', 'platform')

    fireEvent.click(screen.getByTestId('managed-resource-model-tab'))
    const modelResourceManager = await screen.findByTestId('model-resource-manager')
    expect(modelResourceManager).toHaveAttribute('data-scope', 'group')
    expect(modelResourceManager).toHaveAttribute('data-group', 'platform')
  })
})
