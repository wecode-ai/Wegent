// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { Bot, Team } from '@/types/api'
import { updateTeam } from '@/features/settings/services/teams'
import TeamEditDialog from '@/features/settings/components/TeamEditDialog'

const mockRefreshTeams = jest.fn()
const mockTeamModeEditor = jest.fn((_props: Record<string, unknown>) => null)

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'common:actions.cancel': 'Cancel',
        'common:actions.save': 'Save',
        'common:actions.saving': 'Saving...',
        'common:team.name': 'Name',
        'common:team.name_placeholder': 'Team name',
        'common:team.display_name': 'Display name',
        'common:team.display_name_placeholder': 'Agent display name',
        'common:team.description': 'Description',
        'common:team.description_placeholder': 'Description',
        'common:team.bind_mode': 'Bind mode',
        'common:teams.edit_title': 'Edit agent',
        'team.bind_mode_chat': 'Chat',
        'team.bind_mode_code': 'Code',
        'team.bind_mode_task': 'Task',
        'team.bind_mode_video': 'Video',
        'team.bind_mode_image': 'Image',
      }

      return translations[key] || key
    },
  }),
}))

jest.mock('@/features/settings/services/teams', () => ({
  createTeam: jest.fn(),
  updateTeam: jest.fn(),
}))

jest.mock('@/features/settings/components/team-modes', () => ({
  getFilteredBotsForMode: (bots: Bot[]) => bots,
  getActualShellType: (shellType: string) => shellType,
}))

jest.mock('@/features/settings/components/BotEdit', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/contexts/TeamContext', () => ({
  useTeamContext: () => ({
    refreshTeams: mockRefreshTeams,
  }),
}))

jest.mock('@/apis/shells', () => ({
  shellApis: {
    getUnifiedShells: jest.fn().mockResolvedValue({ data: [] }),
  },
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('@/features/settings/components/teams/TeamIconPicker', () => ({
  TeamIconPicker: () => null,
}))

jest.mock('@/features/settings/components/TeamEditDrawer', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/settings/components/team-edit/TeamModeSelector', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/settings/components/team-edit/TeamModeEditor', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => mockTeamModeEditor(props),
}))

jest.mock('@/features/settings/components/team-edit/TeamModeChangeDialog', () => ({
  __esModule: true,
  default: () => null,
}))

const mockedUpdateTeam = updateTeam as jest.MockedFunction<typeof updateTeam>

const makeBot = (): Bot => ({
  id: 10,
  name: 'bot',
  namespace: 'default',
  shell_name: 'ClaudeCode',
  shell_type: 'ClaudeCode',
  agent_config: {},
  system_prompt: '',
  mcp_servers: {},
  is_active: true,
  created_at: '2026-05-09T00:00:00Z',
  updated_at: '2026-05-09T00:00:00Z',
})

const makeTeam = (): Team => ({
  id: 1,
  name: 'dev-team',
  displayName: 'Original Display',
  namespace: 'default',
  description: 'Existing description',
  bots: [{ bot_id: 10, bot_prompt: '', role: 'leader' }],
  workflow: { mode: 'pipeline' },
  is_active: true,
  user_id: 1,
  created_at: '2026-05-09T00:00:00Z',
  updated_at: '2026-05-09T00:00:00Z',
  bind_mode: ['chat'],
})

describe('TeamEditDialog display name', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRefreshTeams.mockResolvedValue(undefined)
    mockTeamModeEditor.mockImplementation(() => null)
  })

  it('edits and saves the team display name', async () => {
    const team = makeTeam()
    mockedUpdateTeam.mockResolvedValue({ ...team, displayName: 'Spec Dev Team' })

    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[team]}
        setTeams={jest.fn()}
        editingTeamId={team.id}
        bots={[makeBot()]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    const displayNameInput = await screen.findByLabelText('Display name')
    expect(displayNameInput).toHaveValue('Original Display')

    fireEvent.change(displayNameInput, { target: { value: 'Spec Dev Team' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockedUpdateTeam).toHaveBeenCalledWith(
        team.id,
        expect.objectContaining({
          name: 'dev-team',
          displayName: 'Spec Dev Team',
        })
      )
    })
  })

  it('restricts the executor to ClaudeCode when code or task mode is selected', async () => {
    const team = makeTeam()
    team.bind_mode = ['code']

    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[team]}
        setTeams={jest.fn()}
        editingTeamId={team.id}
        bots={[makeBot()]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    // 'code' alone is enough to restrict to ClaudeCode
    await screen.findByRole('button', { name: 'Task' })
    expect(mockTeamModeEditor).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowedAgentsForMode: ['ClaudeCode'],
      })
    )

    // Adding 'task' keeps the ClaudeCode restriction
    fireEvent.click(screen.getByRole('button', { name: 'Task' }))

    await waitFor(() => {
      expect(mockTeamModeEditor).toHaveBeenLastCalledWith(
        expect.objectContaining({
          allowedAgentsForMode: ['ClaudeCode'],
        })
      )
    })
  })
})
