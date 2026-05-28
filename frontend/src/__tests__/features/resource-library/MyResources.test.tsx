// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { listGroups } from '@/apis/groups'
import { MyResources } from '@/features/resource-library/components/MyResources'
import type { ResourceLibraryPublishSource } from '@/features/resource-library/types'

const mockPush = jest.fn()

jest.mock('@/apis/groups', () => ({
  listGroups: jest.fn(),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}))

jest.mock('@/features/settings/components/TeamListWithScope', () => ({
  TeamListWithScope: ({
    scope,
    selectedGroup,
    onPublishResource,
  }: {
    scope: string
    selectedGroup?: string | null
    onPublishResource?: (source: ResourceLibraryPublishSource) => void
  }) => (
    <div data-testid="agent-resource-manager" data-scope={scope} data-group={selectedGroup ?? ''}>
      <button
        type="button"
        data-testid="mock-publish-agent"
        onClick={() =>
          onPublishResource?.({
            resourceType: 'agent',
            sourceId: 11,
            name: 'agent-one',
            displayName: 'Agent One',
            description: 'Agent desc',
          })
        }
      >
        publish agent
      </button>
    </div>
  ),
}))

jest.mock('@/features/settings/components/ModelListWithScope', () => ({
  ModelListWithScope: ({
    scope,
    selectedGroup,
  }: {
    scope: string
    selectedGroup?: string | null
  }) => (
    <div data-testid="model-resource-manager" data-scope={scope} data-group={selectedGroup ?? ''} />
  ),
}))

jest.mock('@/features/settings/components/ShellListWithScope', () => ({
  ShellListWithScope: ({
    scope,
    selectedGroup,
  }: {
    scope: string
    selectedGroup?: string | null
  }) => (
    <div data-testid="shell-resource-manager" data-scope={scope} data-group={selectedGroup ?? ''} />
  ),
}))

jest.mock('@/features/settings/components/SkillListWithScope', () => ({
  SkillListWithScope: ({
    scope,
    selectedGroup,
    onPublishResource,
  }: {
    scope: string
    selectedGroup?: string | null
    onPublishResource?: (source: ResourceLibraryPublishSource) => void
  }) => (
    <div data-testid="skill-resource-manager" data-scope={scope} data-group={selectedGroup ?? ''}>
      <button
        type="button"
        data-testid="mock-publish-skill"
        onClick={() =>
          onPublishResource?.({
            resourceType: 'skill',
            sourceId: 22,
            name: 'skill-one',
            displayName: 'Skill One',
            description: 'Skill desc',
            tags: ['chat'],
          })
        }
      >
        publish skill
      </button>
    </div>
  ),
}))

jest.mock('@/features/settings/components/RetrieverListWithScope', () => ({
  RetrieverListWithScope: ({
    scope,
    selectedGroup,
  }: {
    scope: string
    selectedGroup?: string | null
  }) => (
    <div
      data-testid="retriever-resource-manager"
      data-scope={scope}
      data-group={selectedGroup ?? ''}
    />
  ),
}))

jest.mock('@/features/resource-library/components/PublishResourceDialog', () => ({
  PublishResourceDialog: ({
    open,
    sourceResource,
    onOpenChange,
  }: {
    open: boolean
    sourceResource?: ResourceLibraryPublishSource | null
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <div
        data-testid="publish-resource-dialog"
        data-resource-type={sourceResource?.resourceType ?? ''}
        data-source-id={sourceResource?.sourceId ?? ''}
      >
        <button type="button" onClick={() => onOpenChange(false)}>
          close
        </button>
      </div>
    ) : null,
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
        'scopes.personal': '个人资源',
        'scopes.group': '组资源',
        'scopes.group_placeholder': '选择组',
        'actions.manage_groups': '管理...',
        'states.no_groups': '暂无组资源',
      }

      return translations[key] ?? key
    },
  }),
}))

const mockListGroups = listGroups as jest.MockedFunction<typeof listGroups>

async function openGroupMenu() {
  const user = userEvent.setup()
  const groupSelect = screen.getByTestId('resource-group-select')
  await user.click(groupSelect)
  return groupSelect
}

describe('MyResources', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPush.mockClear()
    mockListGroups.mockResolvedValue({
      items: [
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
      ],
      total: 1,
    })
  })

  it('renders the personal agent manager by default', async () => {
    render(<MyResources />)

    expect(await screen.findByTestId('agent-resource-manager')).toHaveAttribute(
      'data-scope',
      'personal'
    )
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

    const groupSelect = screen.getByTestId('resource-group-select')
    expect(groupSelect).toHaveRole('button')
    expect(groupSelect).toHaveTextContent('组资源')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

    await openGroupMenu()
    expect(await screen.findByRole('menuitem', { name: 'Platform' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '管理...' })).toBeInTheDocument()
  })

  it('uses tablet-width layout for the managed resource toolbar', async () => {
    render(<MyResources />)

    const agentTab = screen.getByTestId('managed-resource-agent-tab')
    const toolbar = agentTab.parentElement?.parentElement
    const groupSelect = screen.getByTestId('resource-group-select')

    expect(await screen.findByTestId('agent-resource-manager')).toBeInTheDocument()
    expect(toolbar).toHaveClass('md:flex-row')
    expect(toolbar).toHaveClass('md:items-center')
    expect(toolbar).toHaveClass('md:justify-between')
    expect(toolbar).not.toHaveClass('lg:flex-row')
    expect(agentTab).toHaveClass('md:h-9')
    expect(groupSelect).toHaveClass('md:h-9')
  })

  it('switches between managed resource types', async () => {
    render(<MyResources />)

    expect(await screen.findByTestId('agent-resource-manager')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('managed-resource-model-tab'))
    expect(screen.getByTestId('model-resource-manager')).toHaveAttribute('data-scope', 'personal')

    fireEvent.click(screen.getByTestId('managed-resource-shell-tab'))
    expect(screen.getByTestId('shell-resource-manager')).toHaveAttribute('data-scope', 'personal')

    fireEvent.click(screen.getByTestId('managed-resource-skill-tab'))
    expect(screen.getByTestId('skill-resource-manager')).toHaveAttribute('data-scope', 'personal')

    fireEvent.click(screen.getByTestId('managed-resource-retriever-tab'))
    expect(screen.getByTestId('retriever-resource-manager')).toHaveAttribute(
      'data-scope',
      'personal'
    )
  })

  it('opens publish dialog from the selected agent manager item', async () => {
    render(<MyResources />)

    expect(await screen.findByTestId('agent-resource-manager')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mock-publish-agent'))

    const dialog = screen.getByTestId('publish-resource-dialog')
    expect(dialog).toHaveAttribute('data-resource-type', 'agent')
    expect(dialog).toHaveAttribute('data-source-id', '11')
  })

  it('opens publish dialog from the selected skill manager item', async () => {
    render(<MyResources />)

    expect(await screen.findByTestId('agent-resource-manager')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('managed-resource-skill-tab'))
    fireEvent.click(screen.getByTestId('mock-publish-skill'))

    const dialog = screen.getByTestId('publish-resource-dialog')
    expect(dialog).toHaveAttribute('data-resource-type', 'skill')
    expect(dialog).toHaveAttribute('data-source-id', '22')
  })

  it('passes selected group scope into migrated managers', async () => {
    render(<MyResources />)

    await waitFor(() => expect(mockListGroups).toHaveBeenCalled())
    await openGroupMenu()
    const platformOption = await screen.findByRole('menuitem', { name: 'Platform' })

    fireEvent.click(platformOption)
    await waitFor(() =>
      expect(screen.getByTestId('agent-resource-manager')).toHaveAttribute('data-scope', 'group')
    )
    expect(screen.getByTestId('agent-resource-manager')).toHaveAttribute('data-group', 'platform')

    fireEvent.click(screen.getByTestId('managed-resource-model-tab'))
    expect(screen.getByTestId('model-resource-manager')).toHaveAttribute('data-scope', 'group')
    expect(screen.getByTestId('model-resource-manager')).toHaveAttribute('data-group', 'platform')
  })

  it('navigates to group management from the group resource dropdown', async () => {
    render(<MyResources />)

    await waitFor(() => expect(mockListGroups).toHaveBeenCalled())

    await openGroupMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: '管理...' }))

    expect(mockPush).toHaveBeenCalledWith('/settings?tab=group-manager')
  })
})
