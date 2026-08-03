// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import TeamSelectorButton from '@/features/tasks/components/selector/TeamSelectorButton'
import type { Team } from '@/types/api'
import { userApis } from '@/apis/user'

const mockRefresh = jest.fn()
const mockPush = jest.fn()
let mockQuickAccessTeams: number[] = []
let mockQuickAccessVersion: number | undefined = 7

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      key === 'common:teams.use_more_agents'
        ? '查看全部智能体'
        : typeof fallback === 'string'
          ? fallback
          : key,
  }),
}))

jest.mock('@/components/ui/popover', () => ({
  Popover: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode
    onOpenChange?: (open: boolean) => void
  }) => (
    <div>
      <button
        type="button"
        data-testid="open-team-selector-popover"
        onClick={() => onOpenChange?.(true)}
      />
      {children}
    </div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('@/features/settings/components/wizard/TeamCreationWizard', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/apis/user', () => ({
  userApis: {
    getCurrentUser: jest.fn(),
    updateUser: jest.fn(),
    getQuickAccess: jest.fn(),
    getRecentTeams: jest.fn(),
  },
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: {
      id: 123,
      user_name: 'test-user',
      email: 'test@example.com',
      is_active: true,
      created_at: '2026-05-09T00:00:00Z',
      updated_at: '2026-05-09T00:00:00Z',
      git_info: [],
      preferences: {
        send_key: 'enter',
        quick_access: {
          version: mockQuickAccessVersion,
          teams: mockQuickAccessTeams,
        },
      },
    },
    refresh: mockRefresh,
  }),
}))

const mockedUserApis = userApis as jest.Mocked<typeof userApis>

function makeTeam(overrides: Partial<Team>): Team {
  return {
    id: 1,
    name: 'team',
    namespace: 'default',
    description: '',
    bots: [],
    workflow: { mode: 'solo' },
    is_active: true,
    user_id: 123,
    created_at: '2026-05-09T00:00:00Z',
    updated_at: '2026-05-09T00:00:00Z',
    bind_mode: ['code'],
    ...overrides,
  }
}

describe('TeamSelectorButton', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedUserApis.updateUser.mockResolvedValue(
      {} as Awaited<ReturnType<typeof userApis.updateUser>>
    )
    mockedUserApis.getQuickAccess.mockResolvedValue({
      system_version: 7,
      user_version: 7,
      show_system_recommended: false,
      system_team_ids: [],
      teams: [],
    } as unknown as Awaited<ReturnType<typeof userApis.getQuickAccess>>)
    mockedUserApis.getRecentTeams.mockResolvedValue([])
    mockRefresh.mockResolvedValue(undefined)
    mockQuickAccessTeams = []
    mockQuickAccessVersion = 7
  })

  it('deduplicates system and personal teams with the same identity', async () => {
    const systemTeam = makeTeam({ id: 1, name: 'spec-dev-team', user_id: 0 })
    const userTeam = makeTeam({ id: 2, name: 'spec-dev-team', user_id: 123 })
    const selectedTeam = makeTeam({ id: 3, name: 'dev-team', user_id: 0 })

    render(
      <TeamSelectorButton
        selectedTeam={selectedTeam}
        setSelectedTeam={jest.fn()}
        teams={[systemTeam, userTeam, selectedTeam]}
        disabled={false}
        currentMode="code"
      />
    )

    await screen.findByTestId('favorite-team-button-2')

    const specTeamOptions = screen.getAllByTestId('team-option-spec-dev-team')

    expect(specTeamOptions).toHaveLength(1)
    expect(within(specTeamOptions[0]).queryByText('系统')).not.toBeInTheDocument()
  })

  it('uses team displayName for dropdown labels', async () => {
    const displayTeam = makeTeam({
      id: 2,
      name: 'spec-dev-team',
      displayName: 'Spec Dev Display',
      user_id: 123,
    })
    const selectedTeam = makeTeam({ id: 3, name: 'dev-team', user_id: 0 })

    render(
      <TeamSelectorButton
        selectedTeam={selectedTeam}
        setSelectedTeam={jest.fn()}
        teams={[displayTeam, selectedTeam]}
        disabled={false}
        currentMode="code"
      />
    )

    const option = await screen.findByTestId('team-option-spec-dev-team')
    expect(within(option).getByText('Spec Dev Display')).toBeInTheDocument()
    expect(within(option).queryByText('spec-dev-team')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('common:teams.search_team')).not.toBeInTheDocument()
  })

  it('shows five recent teams and fills missing entries by update time', async () => {
    mockedUserApis.getRecentTeams.mockResolvedValueOnce([
      { id: 3, name: 'team-3', is_system: false },
      { id: 1, name: 'team-1', is_system: false },
    ])
    const teams = [1, 2, 3, 4, 5, 6].map(id =>
      makeTeam({
        id,
        name: `team-${id}`,
        updated_at: `2026-07-0${id}T00:00:00Z`,
      })
    )

    render(
      <TeamSelectorButton
        selectedTeam={teams[0]}
        setSelectedTeam={jest.fn()}
        teams={teams}
        disabled={false}
        currentMode="code"
      />
    )

    await waitFor(() => expect(mockedUserApis.getRecentTeams).toHaveBeenCalled())
    expect(screen.getByText('common:teams.recently_used')).toBeInTheDocument()
    expect(screen.getByTestId('team-option-team-3')).toBeInTheDocument()
    expect(screen.getByTestId('team-option-team-1')).toBeInTheDocument()
    expect(screen.getByTestId('team-option-team-6')).toBeInTheDocument()
    expect(screen.getByTestId('team-option-team-5')).toBeInTheDocument()
    expect(screen.getByTestId('team-option-team-4')).toBeInTheDocument()
    expect(screen.queryByTestId('team-option-team-2')).not.toBeInTheDocument()

    expect(screen.queryByPlaceholderText('common:teams.search_team')).not.toBeInTheDocument()
  })

  it('refreshes recent teams whenever the selector opens', async () => {
    const teams = [1, 2, 3, 4, 5].map(id =>
      makeTeam({
        id,
        name: `team-${id}`,
        updated_at: `2026-07-0${id}T00:00:00Z`,
      })
    )

    render(
      <TeamSelectorButton
        selectedTeam={teams[0]}
        setSelectedTeam={jest.fn()}
        teams={teams}
        disabled={false}
        currentMode="code"
      />
    )

    await waitFor(() => expect(mockedUserApis.getRecentTeams).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('open-team-selector-popover'))

    await waitFor(() => expect(mockedUserApis.getRecentTeams).toHaveBeenCalledTimes(2))
  })

  it('adds a team to quick access favorites from the dropdown without selecting it', async () => {
    mockQuickAccessTeams = [3]
    const setSelectedTeam = jest.fn()
    const candidateTeam = makeTeam({ id: 2, name: 'spec-dev-team', user_id: 123 })
    const selectedTeam = makeTeam({ id: 3, name: 'dev-team', user_id: 0 })

    render(
      <TeamSelectorButton
        selectedTeam={selectedTeam}
        setSelectedTeam={setSelectedTeam}
        teams={[candidateTeam, selectedTeam]}
        disabled={false}
        currentMode="code"
      />
    )

    fireEvent.click(await screen.findByTestId('favorite-team-button-2'))

    await waitFor(() => {
      expect(mockedUserApis.updateUser).toHaveBeenCalledWith({
        preferences: {
          send_key: 'enter',
          quick_access: {
            version: 7,
            teams: [3, 2],
          },
        },
      })
    })
    expect(mockRefresh).toHaveBeenCalled()
    expect(setSelectedTeam).not.toHaveBeenCalled()
  })

  it('keeps user favorites before system recommended teams when adding a favorite', async () => {
    mockQuickAccessTeams = [2, 3]
    mockedUserApis.getQuickAccess.mockResolvedValueOnce({
      system_version: 7,
      user_version: 7,
      show_system_recommended: false,
      system_team_ids: [2],
      teams: [],
    } as unknown as Awaited<ReturnType<typeof userApis.getQuickAccess>>)

    const systemRecommendedTeam = makeTeam({
      id: 2,
      name: 'system-recommended-team',
      user_id: 0,
    })
    const existingFavoriteTeam = makeTeam({ id: 3, name: 'favorite-team', user_id: 123 })
    const candidateTeam = makeTeam({ id: 4, name: 'candidate-team', user_id: 123 })

    render(
      <TeamSelectorButton
        selectedTeam={existingFavoriteTeam}
        setSelectedTeam={jest.fn()}
        teams={[systemRecommendedTeam, existingFavoriteTeam, candidateTeam]}
        disabled={false}
        currentMode="code"
      />
    )

    fireEvent.click(await screen.findByTestId('favorite-team-button-4'))

    await waitFor(() => {
      expect(mockedUserApis.updateUser).toHaveBeenCalledWith({
        preferences: {
          send_key: 'enter',
          quick_access: {
            version: 7,
            teams: [3, 4, 2],
          },
        },
      })
    })
  })

  it('hides favorite actions for teams already recommended by system', async () => {
    mockedUserApis.getQuickAccess.mockResolvedValueOnce({
      system_version: 7,
      user_version: 7,
      show_system_recommended: false,
      system_team_ids: [2],
      teams: [
        {
          id: 2,
          name: 'system-recommended-team',
          display_name: 'System Recommended Team',
          is_system: true,
          recommended_mode: 'code',
        },
      ],
    } as unknown as Awaited<ReturnType<typeof userApis.getQuickAccess>>)

    const systemRecommendedTeam = makeTeam({
      id: 2,
      name: 'system-recommended-team',
      user_id: 0,
    })
    const userTeam = makeTeam({ id: 3, name: 'user-team', user_id: 123 })

    render(
      <TeamSelectorButton
        selectedTeam={userTeam}
        setSelectedTeam={jest.fn()}
        teams={[systemRecommendedTeam, userTeam]}
        disabled={false}
        currentMode="code"
      />
    )

    await waitFor(() => {
      expect(mockedUserApis.getQuickAccess).toHaveBeenCalled()
    })

    expect(await screen.findByTestId('favorite-team-button-3')).toBeInTheDocument()
    expect(screen.queryByTestId('favorite-team-button-2')).not.toBeInTheDocument()
  })

  it('exposes stable test ids for footer actions', async () => {
    const selectedTeam = makeTeam({ id: 3, name: 'dev-team', user_id: 123 })

    render(
      <TeamSelectorButton
        selectedTeam={selectedTeam}
        setSelectedTeam={jest.fn()}
        teams={[selectedTeam]}
        disabled={false}
        currentMode="code"
      />
    )

    const quickCreateButton = await screen.findByTestId('quick-create-button')
    const useMoreButton = screen.getByTestId('team-selector-use-more-agents')

    expect(quickCreateButton).toHaveAttribute('role', 'button')
    expect(screen.getByTestId('settings-button')).toHaveAttribute('role', 'button')
    expect(useMoreButton).toHaveTextContent('查看全部智能体')
    expect(useMoreButton.compareDocumentPosition(quickCreateButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )

    fireEvent.click(useMoreButton)

    expect(mockPush).toHaveBeenCalledWith('/resource-library?tab=mine&type=agent&from=chat')
  })
})
