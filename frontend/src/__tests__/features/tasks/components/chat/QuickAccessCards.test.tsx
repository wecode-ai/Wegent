// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { userApis } from '@/apis/user'
import { QuickAccessCards } from '@/features/tasks/components/chat/QuickAccessCards'
import type { QuickAccessResponse, Team } from '@/types/api'

jest.mock('@/apis/user', () => ({
  userApis: {
    getQuickAccess: jest.fn(),
    getCurrentUser: jest.fn(),
    updateUser: jest.fn(),
  },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'common:teams.no_description': 'No description',
        'common:teams.more': 'More',
        'common:teams.select_team': 'Select team',
        'common:teams.search_team': 'Search team',
        'common:teams.no_match': 'No match',
        'common:teams.reorder_quick_access': 'Drag to reorder',
        'teams.no_teams_title': 'No teams',
        'teams.no_teams_description': 'Create a team first',
        'wizard:wizard_button': 'Create',
      }

      return translations[key] || key
    },
  }),
}))

jest.mock('@/features/settings/components/wizard/TeamCreationWizard', () => ({
  __esModule: true,
  default: () => null,
}))

const mockGetQuickAccess = userApis.getQuickAccess as jest.MockedFunction<
  typeof userApis.getQuickAccess
>
const mockedUserApis = userApis as jest.Mocked<typeof userApis>

const makeTeam = (overrides: Partial<Team>): Team => ({
  id: 1,
  name: 'team',
  namespace: 'default',
  description: 'Team description',
  bots: [],
  workflow: { mode: 'pipeline' },
  is_active: true,
  user_id: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  bind_mode: ['chat'],
  ...overrides,
})

const renderQuickAccessCards = (teams: Team[], quickAccess: QuickAccessResponse) => {
  mockGetQuickAccess.mockResolvedValueOnce(quickAccess)

  return render(
    <QuickAccessCards
      teams={teams}
      selectedTeam={null}
      onTeamSelect={jest.fn()}
      currentMode="chat"
    />
  )
}

describe('QuickAccessCards', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedUserApis.getCurrentUser.mockResolvedValue({
      id: 1,
      user_name: 'user',
      email: 'user@example.com',
      is_active: true,
      created_at: '2026-05-09T00:00:00Z',
      updated_at: '2026-05-09T00:00:00Z',
      git_info: [],
      preferences: {
        send_key: 'enter',
        quick_access: {
          version: 2,
          teams: [2, 3],
        },
      },
    })
    mockedUserApis.updateUser.mockResolvedValue(
      {} as Awaited<ReturnType<typeof userApis.updateUser>>
    )
  })

  test('renders quick access teams with display names and hides unlisted teams', async () => {
    renderQuickAccessCards(
      [
        makeTeam({ id: 1, name: 'unlisted-team', description: 'Should not appear' }),
        makeTeam({ id: 2, name: 'system-team', description: 'System description' }),
        makeTeam({ id: 3, name: 'favorite-team', description: 'Favorite description' }),
      ],
      {
        system_version: 2,
        system_team_ids: [2],
        user_version: 1,
        show_system_recommended: true,
        teams: [
          {
            id: 2,
            name: 'system-team',
            display_name: 'System Team Display',
            is_system: true,
            recommended_mode: 'chat',
          },
          {
            id: 3,
            name: 'favorite-team',
            display_name: 'Favorite Team Display',
            is_system: false,
            recommended_mode: 'chat',
          },
        ],
      }
    )

    expect(await screen.findByText('System Team Display')).toBeInTheDocument()
    expect(screen.getByText('Favorite Team Display')).toBeInTheDocument()
    expect(screen.queryByText('unlisted-team')).not.toBeInTheDocument()
    expect(screen.queryByText('Should not appear')).not.toBeInTheDocument()
  })

  test('does not fall back to all teams when quick access has no teams', async () => {
    renderQuickAccessCards(
      [makeTeam({ id: 1, name: 'regular-team', description: 'Regular description' })],
      {
        system_version: 1,
        system_team_ids: [],
        user_version: 1,
        show_system_recommended: false,
        teams: [],
      }
    )

    await waitFor(() => expect(mockGetQuickAccess).toHaveBeenCalled())

    expect(screen.queryByTestId('quick-access-cards')).not.toBeInTheDocument()
    expect(screen.queryByText('regular-team')).not.toBeInTheDocument()
  })

  test('persists reordered quick access cards after dragging a card', async () => {
    renderQuickAccessCards(
      [
        makeTeam({ id: 2, name: 'system-team', description: 'System description' }),
        makeTeam({ id: 3, name: 'favorite-team', description: 'Favorite description' }),
      ],
      {
        system_version: 2,
        system_team_ids: [2],
        user_version: 2,
        show_system_recommended: false,
        teams: [
          {
            id: 2,
            name: 'system-team',
            display_name: 'System Team Display',
            is_system: true,
            recommended_mode: 'chat',
          },
          {
            id: 3,
            name: 'favorite-team',
            display_name: 'Favorite Team Display',
            is_system: false,
            recommended_mode: 'chat',
          },
        ],
      }
    )

    const container = await screen.findByTestId('quick-access-cards')
    const systemCard = within(container).getByTestId('quick-access-team-system-team')
    const favoriteCard = within(container).getByTestId('quick-access-team-favorite-team')

    fireEvent.dragStart(systemCard, {
      dataTransfer: {
        effectAllowed: '',
        setData: jest.fn(),
      },
    })
    fireEvent.dragOver(favoriteCard, {
      dataTransfer: {
        dropEffect: '',
      },
    })
    fireEvent.drop(favoriteCard)

    await waitFor(() => {
      expect(mockedUserApis.updateUser).toHaveBeenCalledWith({
        preferences: expect.objectContaining({
          send_key: 'enter',
          quick_access: {
            version: 2,
            teams: [3, 2],
          },
        }),
      })
    })

    const reorderedCards = within(container).getAllByTestId(/^quick-access-team-/)
    expect(reorderedCards[0]).toHaveTextContent('Favorite Team Display')
    expect(reorderedCards[1]).toHaveTextContent('System Team Display')
  })

  test('reorders quick access teams by dragging a hidden team in the more popover', async () => {
    renderQuickAccessCards(
      [
        makeTeam({ id: 1, name: 'team-one', description: 'Description one' }),
        makeTeam({ id: 2, name: 'team-two', description: 'Description two' }),
        makeTeam({ id: 3, name: 'team-three', description: 'Description three' }),
        makeTeam({ id: 4, name: 'team-four', description: 'Description four' }),
        makeTeam({ id: 5, name: 'team-five', description: 'Description five' }),
      ],
      {
        system_version: 2,
        system_team_ids: [],
        user_version: 2,
        show_system_recommended: false,
        teams: [
          { id: 1, name: 'team-one', display_name: 'Team One', is_system: false },
          { id: 2, name: 'team-two', display_name: 'Team Two', is_system: false },
          { id: 3, name: 'team-three', display_name: 'Team Three', is_system: false },
          { id: 4, name: 'team-four', display_name: 'Team Four', is_system: false },
          { id: 5, name: 'team-five', display_name: 'Team Five', is_system: false },
        ],
      }
    )

    const container = await screen.findByTestId('quick-access-cards')
    expect(within(container).queryByTestId('quick-access-team-team-five')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('More'))
    const hiddenTeamHandle = await screen.findByTestId('quick-access-sort-handle-5')
    const targetTeamRow = await screen.findByTestId('quick-access-more-team-team-two')

    fireEvent.dragStart(hiddenTeamHandle, {
      dataTransfer: {
        effectAllowed: '',
        setData: jest.fn(),
      },
    })
    fireEvent.dragOver(targetTeamRow, {
      dataTransfer: {
        dropEffect: '',
      },
    })
    fireEvent.drop(targetTeamRow)

    await waitFor(() => {
      expect(mockedUserApis.updateUser).toHaveBeenCalledWith({
        preferences: expect.objectContaining({
          send_key: 'enter',
          quick_access: {
            version: 2,
            teams: [1, 5, 2, 3, 4],
          },
        }),
      })
    })

    const reorderedCards = within(container).getAllByTestId(/^quick-access-team-/)
    expect(reorderedCards[0]).toHaveTextContent('Team One')
    expect(reorderedCards[1]).toHaveTextContent('Team Five')
  })
})
