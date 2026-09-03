// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { Bot, Team } from '@/types/api'
import { updateTeam } from '@/features/settings/services/teams'
import TeamEditDialog from '@/features/settings/components/TeamEditDialog'

const mockRefreshTeams = jest.fn()
const mockTeamModeEditor = jest.fn((_props: Record<string, unknown>) => null)
const mockSimpleTeamEditForm = jest.fn((_props: Record<string, unknown>) => null)

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
        'settings:team.simple.advanced_toggle': 'Advanced mode',
        'settings:team.simple.advanced_toggle_description': 'Configure more options',
        'settings:team.simple.prompt_protection.label': 'Prompt protection',
        'settings:team.simple.prompt_protection.description':
          'Best-effort extra model call; not a security boundary.',
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
  getAllowedAgentsForTeamMode: (mode: string) => {
    if (mode === 'pipeline' || mode === 'coordinate') return ['ClaudeCode']
    if (mode === 'route' || mode === 'collaborate') return []
    return undefined
  },
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

jest.mock('@/apis/shells', () => {
  const actual = jest.requireActual('@/apis/shells')
  return {
    ...actual,
    shellApis: {
      ...actual.shellApis,
      getUnifiedShells: jest.fn().mockResolvedValue({ data: [] }),
    },
  }
})

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    getAgentBindings: jest.fn().mockResolvedValue({ group_names: [] }),
    getPublication: jest.fn().mockResolvedValue({ tags: [], example_conversations: [] }),
    syncAgentBindings: jest.fn().mockResolvedValue(undefined),
    updatePublication: jest.fn().mockResolvedValue(undefined),
    createListing: jest.fn().mockResolvedValue(undefined),
    archiveListing: jest.fn().mockResolvedValue(undefined),
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

jest.mock('@/features/settings/components/team-edit/SimpleTeamEditForm', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => mockSimpleTeamEditForm(props),
}))

const mockedUpdateTeam = updateTeam as jest.MockedFunction<typeof updateTeam>

const makeBot = (shellType = 'ClaudeCode'): Bot => ({
  id: 10,
  name: 'bot',
  namespace: 'default',
  shell_name: shellType,
  shell_type: shellType,
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
    mockSimpleTeamEditForm.mockImplementation(() => null)
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

  it('preserves existing non-simple bind modes when saving advanced teams', async () => {
    const team = makeTeam()
    team.bind_mode = ['knowledge']
    mockedUpdateTeam.mockResolvedValue(team)

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

    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockedUpdateTeam).toHaveBeenCalledWith(
        team.id,
        expect.objectContaining({
          bind_mode: ['knowledge'],
        })
      )
    })
  })

  it('loads prompt protection state into the simple Team editor', async () => {
    const team = makeTeam()
    team.workflow = { mode: 'solo' }
    team.prompt_protection_enabled = true

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

    await waitFor(() => {
      expect(mockSimpleTeamEditForm).toHaveBeenLastCalledWith(
        expect.objectContaining({
          promptProtectionEnabled: true,
        })
      )
    })
  })

  it('loads, toggles, and saves Team-level prompt protection in the advanced editor', async () => {
    const team = makeTeam()
    team.workflow = { mode: 'coordinate' }
    team.prompt_protection_enabled = true
    mockedUpdateTeam.mockResolvedValue({ ...team, prompt_protection_enabled: false })

    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[team]}
        setTeams={jest.fn()}
        editingTeamId={team.id}
        bots={[makeBot('Chat')]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    const toggle = await screen.findByTestId('advanced-prompt-protection-enabled-switch')
    expect(toggle).toBeChecked()
    const hitTarget = toggle.parentElement
    expect(hitTarget?.tagName).toBe('LABEL')
    expect(hitTarget).toHaveClass('min-h-11', 'min-w-11')
    expect(screen.getByText('Prompt protection')).toBeInTheDocument()

    fireEvent.click(hitTarget!)
    expect(toggle).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockedUpdateTeam).toHaveBeenCalledWith(
        team.id,
        expect.objectContaining({
          prompt_protection_enabled: false,
        })
      )
    })
  })

  it('keeps prompt protection state when switching between simple and advanced editors', async () => {
    const team = makeTeam()
    team.workflow = { mode: 'solo' }
    team.prompt_protection_enabled = false

    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[team]}
        setTeams={jest.fn()}
        editingTeamId={team.id}
        bots={[makeBot('Chat')]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    await waitFor(() => {
      expect(mockSimpleTeamEditForm).toHaveBeenLastCalledWith(
        expect.objectContaining({ promptProtectionEnabled: false })
      )
    })
    const simpleProps = mockSimpleTeamEditForm.mock.lastCall?.[0] as {
      setPromptProtectionEnabled: (enabled: boolean) => void
    }
    act(() => simpleProps.setPromptProtectionEnabled(true))

    fireEvent.click(screen.getByTestId('advanced-mode-switch'))
    expect(await screen.findByTestId('advanced-prompt-protection-enabled-switch')).toBeChecked()

    fireEvent.click(screen.getByTestId('advanced-mode-switch'))
    await waitFor(() => {
      expect(mockSimpleTeamEditForm).toHaveBeenLastCalledWith(
        expect.objectContaining({ promptProtectionEnabled: true })
      )
    })
  })

  it('hides prompt protection in the advanced editor for non-Chat leaders', async () => {
    const team = makeTeam()
    team.workflow = { mode: 'coordinate' }

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

    await screen.findByRole('button', { name: 'Save' })
    expect(screen.queryByTestId('advanced-prompt-protection-setting')).not.toBeInTheDocument()
  })

  it('hides prompt protection in the advanced editor for pipeline teams', async () => {
    const team = makeTeam()

    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[team]}
        setTeams={jest.fn()}
        editingTeamId={team.id}
        bots={[makeBot('Chat')]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    await screen.findByRole('button', { name: 'Save' })
    expect(screen.queryByTestId('advanced-prompt-protection-setting')).not.toBeInTheDocument()
  })
})
