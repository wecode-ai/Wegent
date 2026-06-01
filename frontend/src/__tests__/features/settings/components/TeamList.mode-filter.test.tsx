// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'

import TeamList from '@/features/settings/components/TeamList'
import { fetchBotsList } from '@/features/settings/services/bots'
import { fetchTeamsList } from '@/features/settings/services/teams'
import type { Team } from '@/types/api'
import type { Group } from '@/types/group'

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
    'teams.go_to_chat': 'Go to Chat',
    'teams.go_to_code': 'Go to Code',
    'settings:team.list.goToDevice': 'Go to Device',
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
  TeamApiCallButton: () => null,
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
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
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
    created_at: '',
    updated_at: '',
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
  })

  it('shows device teams when the device filter is selected', async () => {
    ;(fetchTeamsList as jest.Mock).mockResolvedValue([
      makeTeam(1, 'chat-agent', ['chat']),
      makeTeam(2, 'device-agent', ['task']),
    ])

    render(<TeamList scope="personal" />)

    await screen.findByText('chat-agent')
    await userEvent.click(screen.getByRole('button', { name: 'Device' }))

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
    expect(screen.getByText('platform')).toBeInTheDocument()
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
