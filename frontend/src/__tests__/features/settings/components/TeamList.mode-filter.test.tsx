// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'

import TeamList from '@/features/settings/components/TeamList'
import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { fetchBotsList } from '@/features/settings/services/bots'
import { fetchTeamsList } from '@/features/settings/services/teams'
import type { Team } from '@/types/api'
import type { Group } from '@/types/group'

Element.prototype.scrollIntoView = jest.fn()

const mockPush = jest.fn()
const mockToast = jest.fn()
const mockT = (key: string, options?: Record<string, unknown>) =>
  ({
    'teams.title': 'Team List',
    'teams.description': 'Agents can run tasks.',
    'teams.filter_all': 'All',
    'teams.filter_chat': 'Chat',
    'teams.filter_code': 'Code',
    'teams.filter_mode': 'Mode',
    'settings:team.list.filterDevice': 'Device',
    'teams.active': 'Active',
    'teams.inactive': 'Inactive',
    'teams.authorized_from_group': `From parent group ${options?.group}`,
    'teams.bot_count': `${options?.count} ${options?.count === 1 ? 'Bot' : 'Bots'}`,
    'teams.go_to_chat': 'Go to Chat',
    'teams.go_to_code': 'Go to Code',
    'teams.more_actions': 'More actions',
    'teams.api_call.action': 'Call via API',
    'teams.unbind': 'Unbind',
    'publication.published_to_library': 'Published to Resource Library',
    'settings:team.list.runOnDevice': 'Run on Device',
    'teams.new_team': 'New Team',
    'bots.manage_bots': 'Manage Bots',
    'wizard:wizard_button': 'Wizard',
    'wizard:wizard_button_tooltip': 'Create with wizard',
    'actions.choose_create_target': `Where should ${options?.action} be saved?`,
    'actions.choose_create_target_description':
      'The save location controls who can see and manage this resource.',
    'targets.personal': 'My Resources',
    'targets.personal_description': 'Only you can see and manage it.',
    'targets.personal_section': 'Personal',
    'targets.group_description': 'Team members can see it and manage it by team permissions.',
    'targets.group_section': 'Team',
    'targets.select': 'Select',
    'search.groups_placeholder': 'Search teams',
    'search.groups_empty': 'No matching teams',
    'teams.no_teams': 'No agents available',
    'resource-library:actions.browse_agent_market': 'Browse Agent Marketplace',
  })[key] || key

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: { id: 1, user_name: 'yansheng3', role: 'user' },
  }),
}))

jest.mock('@/features/settings/services/teams', () => ({
  fetchTeamsList: jest.fn(),
  deleteTeam: jest.fn(),
  shareTeam: jest.fn(),
  checkTeamRunningTasks: jest.fn(),
  copyTeam: jest.fn(),
}))

jest.mock('@/features/settings/services/bots', () => ({
  fetchBotsList: jest.fn(),
}))

jest.mock('@/apis/groups', () => ({
  listGroups: jest.fn().mockResolvedValue({ items: [] }),
}))

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    listMyPublished: jest.fn(),
  },
}))

const mockListMyPublished = resourceLibraryApi.listMyPublished as jest.Mock

jest.mock('@/features/settings/components/TeamEditDialog', () => ({
  __esModule: true,
  default: ({ open, scope, groupName }: { open?: boolean; scope?: string; groupName?: string }) =>
    open ? (
      <div data-testid="team-edit-dialog" data-scope={scope} data-group={groupName ?? ''} />
    ) : null,
}))
jest.mock('@/features/settings/components/BotList', () => () => null)
jest.mock('@/features/settings/components/TeamShareModal', () => () => null)
jest.mock('@/features/settings/components/wizard/TeamCreationWizard', () => () => null)
jest.mock('@/features/settings/components/TeamApiCallButton', () => ({
  TeamApiCallButton: ({
    team,
    emphasized,
    hideTrigger,
    open,
  }: {
    team: Team
    emphasized?: boolean
    hideTrigger?: boolean
    open?: boolean
  }) => (
    <>
      {!hideTrigger && (
        <button
          type="button"
          data-testid={`team-api-call-button-${team.id}`}
          data-emphasized={String(Boolean(emphasized))}
        />
      )}
      {open && <div data-testid={`team-api-call-dialog-${team.id}`} />}
    </>
  ),
}))

jest.mock('@/components/common/UnifiedAddButton', () => ({
  __esModule: true,
  default: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

jest.mock('@/components/ui/dropdown', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    onSelect,
    'data-testid': testId,
  }: {
    children: ReactNode
    onClick?: () => void
    onSelect?: () => void
    'data-testid'?: string
  }) => (
    <button type="button" onClick={onClick || onSelect} data-testid={testId}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

function makeTeam(id: number, name: string, bindMode: Team['bind_mode']): Team {
  return {
    id,
    name,
    description: '',
    bots: [],
    workflow: {},
    is_active: true,
    user_id: 1,
    created_at: '2026-07-29T00:00:00Z',
    updated_at: '2026-07-29T00:00:00Z',
    user: { user_name: 'yansheng3' },
    bind_mode: bindMode,
  }
}

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
    created_at: '',
    updated_at: '',
  },
]

describe('TeamList mode filter', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(fetchBotsList as jest.Mock).mockResolvedValue([])
    mockListMyPublished.mockResolvedValue({ items: [], total: 0, page: 1, limit: 100 })
  })

  it('shows device teams when the device filter is selected', async () => {
    ;(fetchTeamsList as jest.Mock).mockResolvedValue([
      makeTeam(1, 'chat-agent', ['chat']),
      makeTeam(2, 'device-agent', ['task']),
    ])

    render(<TeamList scope="personal" />)

    await screen.findByText('chat-agent')
    fireEvent.keyDown(screen.getByTestId('team-mode-filter-select'), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'Device' }))

    await waitFor(() => {
      expect(screen.queryByText('chat-agent')).not.toBeInTheDocument()
      expect(screen.getByText('device-agent')).toBeInTheDocument()
    })
  })

  it('shows the owning group for group resources when listing all groups', async () => {
    ;(fetchTeamsList as jest.Mock).mockResolvedValue([
      {
        ...makeTeam(3, 'group-agent', ['chat']),
        namespace: 'platform',
      },
    ])

    render(<TeamList scope="group" sourceFilter="group" />)

    await screen.findByText('group-agent')
    expect(screen.getByText('platform')).toHaveClass('text-text-muted')
  })

  it('keeps personal and group agents created by me while excluding other creators', async () => {
    ;(fetchTeamsList as jest.Mock).mockResolvedValue([
      {
        ...makeTeam(10, 'personal-mine-agent', ['chat']),
        namespace: 'default',
      },
      {
        ...makeTeam(11, 'group-mine-agent', ['chat']),
        namespace: 'platform',
      },
      {
        ...makeTeam(12, 'other-user-agent', ['chat']),
        namespace: 'platform',
        user_id: 2,
      },
    ])

    render(<TeamList scope="all" sourceFilter="mine" />)

    expect(await screen.findByText('personal-mine-agent')).toBeInTheDocument()
    expect(screen.getByText('group-mine-agent')).toBeInTheDocument()
    expect(screen.queryByText('other-user-agent')).not.toBeInTheDocument()
  })

  it('uses the marketplace-style card grid in compact capability views', async () => {
    ;(fetchTeamsList as jest.Mock).mockResolvedValue([
      {
        ...makeTeam(8, 'compact-agent', ['chat']),
        namespace: 'platform',
        bots: [{ bot_id: 1, bot_prompt: '' }],
      },
    ])
    mockListMyPublished.mockResolvedValue({
      items: [{ id: 8, status: 'published' }],
      total: 1,
      page: 1,
      limit: 100,
    })

    render(<TeamList scope="group" sourceFilter="group" compact />)

    const card = await screen.findByTestId('team-card-8')
    expect(screen.getByTestId('team-list-items')).toHaveClass(
      'grid',
      'pt-1',
      'sm:grid-cols-2',
      'lg:grid-cols-3',
      'xl:grid-cols-4'
    )
    expect(card).toHaveClass('group', 'relative', 'min-h-[160px]', 'gap-4')
    expect(within(card).getByTestId('resource-icon')).toHaveAttribute('data-icon-source', 'initial')
    expect(within(card).getByTestId('resource-icon')).toHaveClass('h-10', 'w-10', 'rounded-full')
    expect(within(card).getByTestId('use-team-button-8')).toHaveTextContent('Go to Chat')
    expect(within(card).getByTestId('use-team-button-8')).toHaveClass(
      'h-11',
      'flex-1',
      'border-primary/[0.15]',
      'bg-primary/[0.08]',
      'text-primary',
      'md:h-8'
    )
    expect(within(card).getByTestId('use-team-button-8').querySelector('svg')).toBeInTheDocument()
    expect(within(card).queryByTestId('edit-team-button-8')).not.toBeInTheDocument()
    expect(within(card).getByTestId('team-more-actions-button-8')).toHaveAccessibleName(
      'More actions'
    )
    expect(within(card).getByTestId('team-more-actions-button-8')).toHaveClass(
      'h-11',
      'w-11',
      'md:h-8',
      'md:w-8'
    )
    expect(within(card).queryByTestId('team-card-footer-8')).not.toBeInTheDocument()
    expect(within(card).queryByText('yansheng3')).not.toBeInTheDocument()
    expect(within(card).queryByText('2026-07-29')).not.toBeInTheDocument()
    expect(within(card).queryByTestId('team-api-call-button-8')).not.toBeInTheDocument()
    expect(within(card).getByTestId('team-api-call-menu-item-8')).toHaveTextContent('Call via API')
    expect(within(card).getByText('Active')).toBeInTheDocument()
    expect(within(card).getByText('1 Bot')).toBeInTheDocument()
    expect(within(card).getByTestId('published-agent-8-indicator')).toHaveAccessibleName(
      'Published to Resource Library'
    )
  })

  it('shows edit on team-shared cards for members with edit permission', async () => {
    ;(fetchTeamsList as jest.Mock).mockResolvedValue([
      {
        ...makeTeam(13, 'editable-team-agent', ['chat']),
        namespace: 'platform',
      },
    ])

    render(
      <TeamList
        scope="group"
        sourceFilter="group"
        compact
        groupRoleMap={new Map([['platform', 'Developer']])}
      />
    )

    const card = await screen.findByTestId('team-card-13')
    expect(within(card).getByTestId('edit-team-button-13')).toBeInTheDocument()
  })

  it('keeps team-shared cards read-only for members without edit permission', async () => {
    ;(fetchTeamsList as jest.Mock).mockResolvedValue([
      {
        ...makeTeam(14, 'readonly-team-agent', ['chat']),
        namespace: 'platform',
      },
    ])

    render(
      <TeamList
        scope="group"
        sourceFilter="group"
        compact
        groupRoleMap={new Map([['platform', 'Reporter']])}
      />
    )

    const card = await screen.findByTestId('team-card-14')
    expect(within(card).queryByTestId('edit-team-button-14')).not.toBeInTheDocument()
  })

  it('links an empty all-agents capability view to the agent marketplace', async () => {
    ;(fetchTeamsList as jest.Mock).mockResolvedValue([])

    render(<TeamList scope="all" sourceFilter="all" compact />)

    const marketButton = await screen.findByTestId('team-empty-browse-market-button')
    expect(marketButton).toHaveTextContent('Browse Agent Marketplace')

    await userEvent.click(marketButton)

    expect(mockPush).toHaveBeenCalledWith('/resource-library?type=agent')
  })

  it('keeps a parent-group agent authorized through the selected child group', async () => {
    ;(fetchTeamsList as jest.Mock).mockImplementation(
      (_scope: string, selectedGroupName?: string) =>
        Promise.resolve(
          selectedGroupName === 'child-group'
            ? [
                {
                  ...makeTeam(6, 'authorized-agent', ['chat']),
                  namespace: 'parent-group',
                  share_status: 2,
                  access_source: 'namespace_authorization',
                },
              ]
            : []
        )
    )

    render(<TeamList scope="group" sourceFilter="group" groupFilter={['child-group']} />)

    expect(await screen.findByText('authorized-agent')).toBeInTheDocument()
    expect(fetchTeamsList).toHaveBeenCalledWith('group', 'child-group')
    const card = screen.getByTestId('team-card-6')
    expect(within(card).getByText('From parent group parent-group')).toBeInTheDocument()
    expect(within(card).queryByText('parent-group', { exact: true })).not.toBeInTheDocument()
  })

  it('shows a personal-source agent authorized to a group', async () => {
    ;(fetchTeamsList as jest.Mock).mockResolvedValue([
      {
        ...makeTeam(9, 'bound-personal-agent', ['chat']),
        namespace: 'default',
        share_status: 2,
        access_source: 'namespace_authorization',
      },
    ])

    render(<TeamList scope="group" sourceFilter="group" />)

    const card = (await screen.findByText('bound-personal-agent')).closest(
      '[data-testid="team-card-9"]'
    )
    expect(card).not.toBeNull()
    expect(within(card as HTMLElement).queryByText('Unbind')).not.toBeInTheDocument()
  })

  it('merges and deduplicates agents resolved through multiple selected groups', async () => {
    const sharedAgent = {
      ...makeTeam(7, 'shared-authorized-agent', ['chat']),
      namespace: 'parent-group',
      share_status: 2,
      access_source: 'namespace_authorization' as const,
    }
    ;(fetchTeamsList as jest.Mock).mockResolvedValue([sharedAgent])

    render(
      <TeamList
        scope="group"
        sourceFilter="group"
        groupFilter={['child-group-a', 'child-group-b']}
      />
    )

    expect(await screen.findByText('shared-authorized-agent')).toBeInTheDocument()
    expect(screen.getAllByText('shared-authorized-agent')).toHaveLength(1)
    expect(fetchTeamsList).toHaveBeenCalledWith('group', 'child-group-a')
    expect(fetchTeamsList).toHaveBeenCalledWith('group', 'child-group-b')
  })

  it('keeps source and mode filters in the same toolbar area above the list', async () => {
    ;(fetchTeamsList as jest.Mock).mockResolvedValue([makeTeam(4, 'flat-agent', ['chat'])])

    render(<TeamList scope="all" sourceControls={<div data-testid="source-filter">Source</div>} />)

    await screen.findByText('flat-agent')

    const sourceFilter = screen.getByTestId('source-filter')
    const modeFilter = screen.getByTestId('team-mode-filter')
    const listItems = screen.getByTestId('team-list-items')

    expect(sourceFilter.closest('[data-testid="resource-page-filter-bar"]')).toBe(
      modeFilter.closest('[data-testid="resource-page-filter-bar"]')
    )
    expect(listItems).not.toHaveClass('border')
    expect(screen.queryByTestId('team-list-actions')).not.toBeInTheDocument()
  })

  it('shows creation actions in the page header when the default all source filter is selected', async () => {
    ;(fetchTeamsList as jest.Mock).mockResolvedValue([makeTeam(5, 'all-agent', ['chat'])])

    render(<TeamList scope="all" sourceFilter="all" groups={groups} />)

    await screen.findByText('all-agent')

    const headerActions = screen.getByTestId('resource-page-header-actions')
    expect(within(headerActions).getByRole('button', { name: 'New Team' })).toBeInTheDocument()
    expect(within(headerActions).getByRole('button', { name: 'Wizard' })).toBeInTheDocument()
    expect(screen.queryByTestId('team-list-actions')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Manage Bots' })).not.toBeInTheDocument()

    await userEvent.click(within(headerActions).getByRole('button', { name: 'New Team' }))
    await userEvent.click(await screen.findByTestId('create-team-button-group-option-platform'))

    expect(screen.getByTestId('team-edit-dialog')).toHaveAttribute('data-scope', 'group')
    expect(screen.getByTestId('team-edit-dialog')).toHaveAttribute('data-group', 'platform')
  })
})
