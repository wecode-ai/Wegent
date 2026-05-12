// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import TeamSelectorButton from '@/features/tasks/components/selector/TeamSelectorButton'
import type { Team } from '@/types/api'
import { userApis } from '@/apis/user'

const mockRefresh = jest.fn()
let mockQuickAccessTeams: number[] = []
let mockQuickAccessVersion: number | undefined = 7

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : _key,
  }),
}))

jest.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
    mockRefresh.mockResolvedValue(undefined)
    mockQuickAccessTeams = []
    mockQuickAccessVersion = 7
  })

  it('marks system teams in the dropdown when names overlap', async () => {
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

    await screen.findByTestId('favorite-team-button-1')

    const specTeamOptions = screen.getAllByTestId('team-option-spec-dev-team')

    expect(specTeamOptions).toHaveLength(2)
    expect(within(specTeamOptions[0]).getByText('系统')).toBeInTheDocument()
    expect(within(specTeamOptions[1]).queryByText('系统')).not.toBeInTheDocument()
  })

  it('uses team displayName for dropdown labels and search', async () => {
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

    fireEvent.change(screen.getByPlaceholderText('common:teams.search_team'), {
      target: { value: 'Display' },
    })

    const option = await screen.findByTestId('team-option-spec-dev-team')
    expect(within(option).getByText('Spec Dev Display')).toBeInTheDocument()
    expect(within(option).queryByText('spec-dev-team')).not.toBeInTheDocument()
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
})
