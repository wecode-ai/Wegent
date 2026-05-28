// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'

import { userApis } from '@/apis/user'
import { QuickAccessCards } from '@/features/tasks/components/chat/QuickAccessCards'
import type { QuickAccessResponse, QuickLaunchResponse, Team } from '@/types/api'

jest.mock('@/apis/user', () => ({
  userApis: {
    getQuickAccess: jest.fn(),
    getQuickLaunch: jest.fn(),
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
        'teams.create_first_team': 'Create Agent',
        'teams.no_teams_title': 'No teams',
        'teams.no_teams_description': 'Create a team first',
      }

      return translations[key] || key
    },
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: jest.fn(),
  }),
}))

jest.mock('@/features/settings/components/TeamEditDialog', () => ({
  __esModule: true,
  default: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <div data-testid="simple-team-edit-dialog">
        Simple Team Edit Dialog
        <button type="button" onClick={onClose}>
          Close dialog
        </button>
      </div>
    ) : null,
}))

const mockGetQuickAccess = userApis.getQuickAccess as jest.MockedFunction<
  typeof userApis.getQuickAccess
>
const mockGetQuickLaunch = userApis.getQuickLaunch as jest.MockedFunction<
  typeof userApis.getQuickLaunch
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

const renderQuickAccessCards = (
  teams: Team[],
  quickAccess: QuickAccessResponse,
  props: Partial<ComponentProps<typeof QuickAccessCards>> = {}
) => {
  mockGetQuickAccess.mockResolvedValueOnce(quickAccess)

  return render(
    <QuickAccessCards
      teams={teams}
      selectedTeam={null}
      onTeamSelect={jest.fn()}
      currentMode="chat"
      {...props}
    />
  )
}

describe('QuickAccessCards', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetQuickLaunch.mockResolvedValue({
      system_functions: [],
      favorite_agents: [],
    })
    mockGetQuickAccess.mockResolvedValue({
      system_version: 0,
      system_team_ids: [],
      user_version: 0,
      show_system_recommended: false,
      teams: [],
    })
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
    mockGetQuickLaunch.mockResolvedValueOnce({
      system_functions: [],
      favorite_agents: [
        {
          type: 'favorite_agent',
          id: 2,
          team_id: 2,
          name: 'system-team',
          title: 'System Team Display',
          quick_phrases: [],
        },
        {
          type: 'favorite_agent',
          id: 3,
          team_id: 3,
          name: 'favorite-team',
          title: 'Favorite Team Display',
          quick_phrases: [],
        },
      ],
    } satisfies QuickLaunchResponse)

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

  test('renders system functions and favorite agents in separate rows', async () => {
    mockGetQuickLaunch.mockResolvedValueOnce({
      system_functions: [
        {
          type: 'system_function',
          id: 'create_ppt',
          title: 'Create PPT',
          team_id: 2,
          name: 'system-team',
          enabled: true,
          order: 10,
          quick_phrases: ['帮我创建一个 xxx 的 PPT'],
        },
      ],
      favorite_agents: [
        {
          type: 'favorite_agent',
          id: 3,
          team_id: 3,
          name: 'favorite-team',
          title: 'Favorite Team Display',
          quick_phrases: ['帮我生成周报'],
        },
      ],
    } satisfies QuickLaunchResponse)

    renderQuickAccessCards(
      [
        makeTeam({ id: 2, name: 'system-team', description: 'System description' }),
        makeTeam({ id: 3, name: 'favorite-team', description: 'Favorite description' }),
      ],
      {
        system_version: 2,
        system_team_ids: [],
        user_version: 2,
        show_system_recommended: false,
        teams: [],
      }
    )

    expect(await screen.findByTestId('quick-launch-system-row')).toHaveTextContent('Create PPT')
    expect(screen.getByTestId('quick-launch-favorites-row')).toHaveTextContent(
      'Favorite Team Display'
    )
  })

  test('shows quick phrases after clicking a launcher and fills input without sending', async () => {
    const onPhraseSelect = jest.fn()
    const onTeamSelect = jest.fn()
    mockGetQuickLaunch.mockResolvedValueOnce({
      system_functions: [
        {
          type: 'system_function',
          id: 'create_ppt',
          title: 'Create PPT',
          team_id: 2,
          name: 'system-team',
          enabled: true,
          order: 10,
          quick_phrases: ['帮我创建一个 xxx 的 PPT', '把这份大纲整理成 PPT'],
        },
      ],
      favorite_agents: [],
    } satisfies QuickLaunchResponse)

    render(
      <QuickAccessCards
        teams={[makeTeam({ id: 2, name: 'system-team', description: 'System description' })]}
        selectedTeam={null}
        onTeamSelect={onTeamSelect}
        onPhraseSelect={onPhraseSelect}
        currentMode="chat"
      />
    )

    fireEvent.click(await screen.findByText('Create PPT'))

    expect(screen.queryByTestId('quick-launch-cards')).not.toBeInTheDocument()
    expect(screen.getByTestId('quick-phrase-list')).toBeInTheDocument()
    expect(screen.getByTestId('quick-phrase-back')).toHaveTextContent('Create PPT')

    fireEvent.click(screen.getByText('帮我创建一个 xxx 的 PPT'))

    expect(onTeamSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }))
    expect(onPhraseSelect).toHaveBeenCalledWith('帮我创建一个 xxx 的 PPT')
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

    expect(screen.queryByText('regular-team')).not.toBeInTheDocument()
  })

  test('opens quick access teams from the more popover', async () => {
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

    expect(await screen.findByTestId('quick-launch-cards')).toBeInTheDocument()

    fireEvent.click(screen.getByText('More'))

    expect(await screen.findByTestId('quick-access-more-team-system-team')).toHaveTextContent(
      'System Team Display'
    )
    expect(screen.getByTestId('quick-access-more-team-favorite-team')).toHaveTextContent(
      'Favorite Team Display'
    )
  })

  test('opens the simple agent editor from the quick create card', async () => {
    renderQuickAccessCards(
      [makeTeam({ id: 2, name: 'system-team', description: 'System description' })],
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
        ],
      },
      { showWizardButton: true }
    )

    const quickCreate = await screen.findByTestId('quick-create-agent')
    expect(quickCreate.tagName).toBe('BUTTON')
    expect(quickCreate).toHaveAttribute('type', 'button')

    fireEvent.click(quickCreate)

    expect(screen.getByTestId('simple-team-edit-dialog')).toBeInTheDocument()
  })

  test('does not refresh teams when the create dialog closes without a created agent', async () => {
    const onRefreshTeams = jest.fn().mockResolvedValue([])
    renderQuickAccessCards(
      [makeTeam({ id: 2, name: 'system-team', description: 'System description' })],
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
        ],
      },
      { showWizardButton: true, onRefreshTeams }
    )

    fireEvent.click(await screen.findByTestId('quick-create-agent'))
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))

    await waitFor(() => {
      expect(screen.queryByTestId('simple-team-edit-dialog')).not.toBeInTheDocument()
    })
    expect(onRefreshTeams).not.toHaveBeenCalled()
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

    expect(await screen.findByTestId('quick-launch-cards')).toBeInTheDocument()
    expect(screen.queryByText('Team Five')).not.toBeInTheDocument()

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
  })
})
