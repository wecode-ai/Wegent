// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'

import { botApis } from '@/apis/bots'
import TeamEditDialog from '@/features/settings/components/TeamEditDialog'
import type TeamModeEditor from '@/features/settings/components/team-edit/TeamModeEditor'
import type SimpleTeamEditForm from '@/features/settings/components/team-edit/SimpleTeamEditForm'
import { createTeam, updateTeam } from '@/features/settings/services/teams'
import type { Bot, Team } from '@/types/api'

jest.mock('next/image', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/hooks/useTranslation', () => {
  const t = (key: string) =>
    ({
      'team.model': 'Collaboration mode',
      'common:actions.save': 'Save',
      'common:common.confirm': 'Confirm',
      'common:common.cancel': 'Cancel',
      'common:team.mode_change_confirm_title': 'Change mode?',
      'common:teams.create_title': 'Create agent',
      'common:teams.description': 'Agent settings',
      'team_model.solo': 'Solo',
      'team_model.pipeline': 'Pipeline',
      'team_model.coordinate': 'Coordinate',
      'team_model_desc.solo': 'Single bot handles everything.',
      'team_model_desc.pipeline': 'Bots execute sequentially.',
      'team_model_desc.coordinate': 'Leader coordinates parallel work.',
    })[key] || key
  const i18n = { language: 'en' }
  return { useTranslation: () => ({ t, i18n }) }
})

jest.mock('@/features/settings/services/teams', () => ({
  createTeam: jest.fn(),
  updateTeam: jest.fn(),
}))

jest.mock('@/features/settings/components/team-modes', () => ({
  getSelectableTeamModes: () => ['solo', 'pipeline', 'coordinate'],
  getAllowedAgentsForTeamMode: (mode: string) => {
    if (mode === 'pipeline' || mode === 'coordinate') return ['Codex', 'ClaudeCode']
    return undefined
  },
  getFilteredBotsForMode: (bots: unknown[]) => bots,
  getActualShellType: (shellType: string) => shellType,
}))

jest.mock('@/apis/bots', () => ({
  botApis: {
    createBot: jest.fn(),
    updateBot: jest.fn(),
  },
}))

jest.mock('@/apis/models', () => ({
  modelApis: {
    getUnifiedModels: jest.fn().mockResolvedValue({ data: [] }),
  },
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

jest.mock('@/apis/skills', () => ({
  fetchUnifiedSkillsList: jest.fn().mockResolvedValue([]),
}))

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    getAgentBindings: jest.fn().mockResolvedValue({ group_names: [] }),
    getPublication: jest.fn().mockResolvedValue({ tags: [], example_conversations: [] }),
    syncAgentBindings: jest.fn().mockResolvedValue({}),
  },
}))

jest.mock('@/contexts/TeamContext', () => ({
  useTeamContext: () => ({
    invalidateTeams: jest.fn(),
  }),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open === false ? null : <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

jest.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean
    disabled?: boolean
    onCheckedChange?: (checked: boolean) => void
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={event => onCheckedChange?.(event.target.checked)}
      {...props}
    />
  ),
}))

jest.mock('@/features/settings/components/teams/TeamIconPicker', () => ({
  TeamIconPicker: () => null,
}))

jest.mock('@/features/settings/components/team-edit/TeamBasicInfoForm', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/settings/components/team-edit/TeamModeEditor', () => ({
  __esModule: true,
  default: ({
    mode,
    leaderBotId,
    selectedBotKeys,
    setLeaderBotId,
    setSelectedBotKeys,
  }: ComponentProps<typeof TeamModeEditor>) => (
    <div data-testid="member-editor">
      <span>{mode}</span>
      <output data-testid="selected-members">
        {leaderBotId}:{selectedBotKeys.join(',')}
      </output>
      <button
        onClick={() => {
          setLeaderBotId(20)
          setSelectedBotKeys(['20', '10'])
        }}
      >
        Select members
      </button>
      <button
        onClick={() => {
          setLeaderBotId(10)
          setSelectedBotKeys(['10'])
        }}
      >
        Remove member
      </button>
    </div>
  ),
}))

jest.mock('@/features/settings/components/team-edit/SimpleTeamEditForm', () => ({
  __esModule: true,
  default: ({
    collaborationModeSelector,
    displayName,
    setDisplayName,
    prompt,
    onPromptChange,
    bindMode,
    setBindMode,
    selectedSkills,
    onSkillsChange,
    mcpConfig,
    onMcpConfigChange,
    inheritBaseCapabilities,
    onInheritBaseCapabilitiesChange,
  }: ComponentProps<typeof SimpleTeamEditForm>) => (
    <div data-testid="simple-editor">
      <input
        aria-label="Name"
        value={displayName}
        onChange={event => setDisplayName(event.target.value)}
      />
      <textarea
        aria-label="Prompt"
        value={prompt}
        onChange={event => onPromptChange(event.target.value)}
      />
      <output data-testid="solo-draft">
        {JSON.stringify({ bindMode, selectedSkills, mcpConfig, inheritBaseCapabilities })}
      </output>
      <button onClick={() => setBindMode(['chat'])}>Use chat</button>
      <button
        onClick={() => {
          onSkillsChange([], {})
          onMcpConfigChange('')
          onInheritBaseCapabilitiesChange(false)
        }}
      >
        Clear Bot capabilities
      </button>
      {collaborationModeSelector}
    </div>
  ),
}))

jest.mock('@/features/settings/components/TeamEditDrawer', () => ({
  __esModule: true,
  default: () => null,
}))

const bots: Bot[] = [10, 20].map(id => ({
  id,
  name: `bot-${id}`,
  namespace: 'default',
  shell_name: 'Codex',
  shell_type: 'Codex',
  agent_config: {},
  system_prompt: '',
  mcp_servers: {},
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}))

const existingTeam: Team = {
  id: 1,
  name: 'test-agent',
  displayName: 'Test agent',
  description: '',
  namespace: 'default',
  workflow: { mode: 'solo', leader_bot_id: '10' },
  bind_mode: ['chat', 'code', 'task'],
  bots: [{ bot_id: 10, role: 'leader', bot_prompt: '' }],
  is_active: true,
  user_id: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

function createProps(): ComponentProps<typeof TeamEditDialog> {
  return {
    open: true,
    onClose: jest.fn(),
    teams: [],
    setTeams: jest.fn(),
    editingTeamId: 0,
    bots,
    setBots: jest.fn(),
    toast: jest.fn(),
  }
}

describe('TeamEditDialog team mode selector', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(createTeam).mockResolvedValue(existingTeam)
    jest.mocked(updateTeam).mockResolvedValue(existingTeam)
  })

  it('defaults to solo and passes the supported modes into the simple form', () => {
    render(<TeamEditDialog {...createProps()} />)

    expect(screen.queryByTestId('advanced-mode-switch')).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Solo' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Pipeline' })).toBeVisible()
    expect(screen.getByRole('radio', { name: 'Coordinate' })).toBeVisible()
    expect(screen.getByTestId('simple-editor')).toContainElement(
      screen.getByRole('radio', { name: 'Solo' })
    )
    expect(screen.queryByTestId('member-editor')).not.toBeInTheDocument()
  })

  it.each(['pipeline', 'coordinate'])(
    'creates a %s agent with its selected members',
    async mode => {
      const props = createProps()
      render(<TeamEditDialog {...props} />)

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My agent' } })
      fireEvent.click(screen.getByTestId(`select-mode-label-${mode}`))

      expect(screen.queryByTestId('simple-editor')).not.toBeInTheDocument()
      expect(screen.getByTestId('member-editor')).toHaveTextContent(mode)

      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(createTeam).not.toHaveBeenCalled()
      expect(props.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'common:team.leader_required' })
      )

      fireEvent.click(screen.getByRole('button', { name: 'Select members' }))
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => {
        expect(createTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            displayName: 'My agent',
            workflow: { mode, leader_bot_id: 20 },
            bots: [
              expect.objectContaining({ bot_id: 20, role: 'leader' }),
              expect.objectContaining({ bot_id: 10 }),
            ],
          })
        )
        expect(props.onClose).toHaveBeenCalled()
      })
      expect(botApis.createBot).not.toHaveBeenCalled()
    }
  )

  it('preserves the solo draft when switching back before selecting members', () => {
    render(<TeamEditDialog {...createProps()} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Draft agent' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Draft prompt' } })
    fireEvent.click(screen.getByTestId('select-mode-label-pipeline'))
    fireEvent.click(screen.getByTestId('select-mode-label-solo'))

    expect(screen.getByLabelText('Name')).toHaveValue('Draft agent')
    expect(screen.getByLabelText('Prompt')).toHaveValue('Draft prompt')
  })

  it('resets the mode and draft when a new creation dialog is reopened', () => {
    const props = createProps()
    const { rerender } = render(<TeamEditDialog {...props} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Discarded draft' } })
    fireEvent.click(screen.getByTestId('select-mode-label-coordinate'))

    rerender(<TeamEditDialog {...props} open={false} />)
    rerender(<TeamEditDialog {...props} />)

    expect(screen.getByRole('radio', { name: 'Solo' })).toBeChecked()
    expect(screen.getByLabelText('Name')).toHaveValue('')
  })

  it('confirms a mode change and keeps it across bot catalog refreshes', async () => {
    const props = { ...createProps(), editingTeamId: 1, teams: [existingTeam] }
    const { rerender } = render(<TeamEditDialog {...props} />)

    fireEvent.click(screen.getByTestId('select-mode-label-pipeline'))
    expect(screen.getByRole('heading', { name: 'Change mode?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('radio', { name: 'Solo' })).toBeChecked()

    fireEvent.click(screen.getByTestId('select-mode-label-pipeline'))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(screen.getByTestId('selected-members')).toHaveTextContent(/^:$/)
    fireEvent.click(screen.getByRole('button', { name: 'Select members' }))

    rerender(<TeamEditDialog {...props} bots={[...bots]} />)
    expect(screen.getByRole('radio', { name: 'Pipeline' })).toBeChecked()
    expect(screen.getByTestId('selected-members')).toHaveTextContent('20:20,10')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(updateTeam).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          workflow: { mode: 'pipeline', leader_bot_id: 20 },
          bind_mode: ['chat', 'code', 'task'],
        })
      )
    )
  })

  it.each(['pipeline', 'coordinate'] as const)(
    'preserves unsaved %s members and leader after saving a member prompt',
    async mode => {
      const team: Team = {
        ...existingTeam,
        workflow: { mode, leader_bot_id: '10' },
      }
      const props = { ...createProps(), editingTeamId: team.id, teams: [team] }
      const { rerender } = render(<TeamEditDialog {...props} />)
      expect(screen.getByTestId('selected-members')).toHaveTextContent('10:10')

      fireEvent.click(screen.getByRole('button', { name: 'Select members' }))
      rerender(
        <TeamEditDialog
          {...props}
          bots={bots.map(bot =>
            bot.id === 20 ? { ...bot, system_prompt: 'Updated diagnosis prompt' } : bot
          )}
        />
      )

      expect(screen.getByTestId('selected-members')).toHaveTextContent('20:20,10')
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() =>
        expect(updateTeam).toHaveBeenCalledWith(
          team.id,
          expect.objectContaining({
            workflow: { mode, leader_bot_id: 20 },
            bots: [
              expect.objectContaining({ bot_id: 20, role: 'leader' }),
              expect.objectContaining({ bot_id: 10 }),
            ],
          })
        )
      )
    }
  )

  it('keeps saved members selected while the bot catalog is loading', async () => {
    const team: Team = {
      ...existingTeam,
      workflow: { mode: 'pipeline', leader_bot_id: '10' },
    }
    const props = { ...createProps(), editingTeamId: team.id, teams: [team] }
    const { rerender } = render(<TeamEditDialog {...props} bots={[]} />)

    expect(screen.getByTestId('selected-members')).toHaveTextContent('10:10')
    fireEvent.click(screen.getByRole('button', { name: 'Select members' }))
    rerender(<TeamEditDialog {...props} />)

    expect(screen.getByTestId('selected-members')).toHaveTextContent('20:20,10')
    await act(async () => {})
  })

  it('preserves solo draft fields across bot catalog updates', async () => {
    const props = { ...createProps(), editingTeamId: 1, teams: [existingTeam] }
    const { rerender } = render(<TeamEditDialog {...props} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Draft name' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Draft prompt' } })

    rerender(<TeamEditDialog {...props} bots={[...bots]} />)

    expect(screen.getByLabelText('Name')).toHaveValue('Draft name')
    expect(screen.getByLabelText('Prompt')).toHaveValue('Draft prompt')
    await act(async () => {})
  })

  it('does not restore a removed member when another member prompt is saved', async () => {
    const team: Team = {
      ...existingTeam,
      workflow: { mode: 'pipeline', leader_bot_id: '10' },
      bots: [...existingTeam.bots, { bot_id: 20, bot_prompt: '' }],
    }
    const props = { ...createProps(), editingTeamId: team.id, teams: [team] }
    const { rerender } = render(<TeamEditDialog {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove member' }))

    rerender(
      <TeamEditDialog
        {...props}
        bots={bots.map(bot => ({ ...bot, system_prompt: 'Updated prompt' }))}
      />
    )

    expect(screen.getByTestId('selected-members')).toHaveTextContent(/^10:10$/)
    await act(async () => {})
  })

  it('hydrates a late solo bot once without resetting the agent name', async () => {
    const props = { ...createProps(), editingTeamId: 1, teams: [existingTeam] }
    const { rerender } = render(<TeamEditDialog {...props} bots={[]} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Draft name' } })

    const loadedBots = bots.map(bot => ({ ...bot, system_prompt: 'Saved prompt' }))
    rerender(<TeamEditDialog {...props} bots={loadedBots} />)
    expect(screen.getByLabelText('Name')).toHaveValue('Draft name')
    expect(screen.getByLabelText('Prompt')).toHaveValue('Saved prompt')
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Draft prompt' } })
    rerender(<TeamEditDialog {...props} bots={[...loadedBots]} />)
    expect(screen.getByLabelText('Prompt')).toHaveValue('Draft prompt')
    await act(async () => {})
  })

  it.each(['Draft prompt', ''])(
    'preserves an edited solo prompt %p before the bot catalog arrives',
    async draftPrompt => {
      const props = { ...createProps(), editingTeamId: 1, teams: [existingTeam] }
      const { rerender } = render(<TeamEditDialog {...props} bots={[]} />)
      fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Draft prompt' } })
      fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: draftPrompt } })

      rerender(
        <TeamEditDialog
          {...props}
          bots={bots.map(bot => ({ ...bot, system_prompt: 'Saved prompt', skills: ['saved'] }))}
        />
      )

      expect(screen.getByLabelText('Prompt')).toHaveValue(draftPrompt)
      expect(
        JSON.parse(screen.getByTestId('solo-draft').textContent || '{}').selectedSkills
      ).toEqual(['saved'])
      await act(async () => {})
    }
  )

  it('preserves explicitly cleared Bot capabilities before the catalog arrives', async () => {
    const props = { ...createProps(), editingTeamId: 1, teams: [existingTeam] }
    const { rerender } = render(<TeamEditDialog {...props} bots={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear Bot capabilities' }))

    rerender(
      <TeamEditDialog
        {...props}
        bots={bots.map(bot => ({
          ...bot,
          skills: ['saved'],
          mcp_servers: { saved: { command: 'saved' } },
          inherit_base_capabilities: true,
        }))}
      />
    )

    expect(JSON.parse(screen.getByTestId('solo-draft').textContent || '{}')).toEqual(
      expect.objectContaining({ selectedSkills: [], mcpConfig: '', inheritBaseCapabilities: false })
    )
    await act(async () => {})
  })

  it('preserves a user-selected solo bind mode before the bot catalog arrives', async () => {
    const props = { ...createProps(), editingTeamId: 1, teams: [existingTeam] }
    const { rerender } = render(<TeamEditDialog {...props} bots={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Use chat' }))

    rerender(<TeamEditDialog {...props} />)

    expect(JSON.parse(screen.getByTestId('solo-draft').textContent || '{}').bindMode).toEqual([
      'chat',
    ])
    await act(async () => {})
  })

  it('clears solo field edit markers when reopening the dialog', async () => {
    const props = { ...createProps(), editingTeamId: 1, teams: [existingTeam] }
    const { rerender } = render(<TeamEditDialog {...props} bots={[]} />)
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Discard this draft' } })

    rerender(<TeamEditDialog {...props} bots={[]} open={false} />)
    rerender(<TeamEditDialog {...props} bots={[]} />)
    rerender(
      <TeamEditDialog
        {...props}
        bots={bots.map(bot => ({ ...bot, system_prompt: 'Saved prompt' }))}
      />
    )

    expect(screen.getByLabelText('Prompt')).toHaveValue('Saved prompt')
    await act(async () => {})
  })

  it('discards member edits on reopen and initializes a different agent', async () => {
    const team: Team = {
      ...existingTeam,
      workflow: { mode: 'pipeline', leader_bot_id: '10' },
    }
    const props = { ...createProps(), editingTeamId: team.id, teams: [team] }
    const { rerender } = render(<TeamEditDialog {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Select members' }))

    rerender(<TeamEditDialog {...props} open={false} />)
    rerender(<TeamEditDialog {...props} />)
    expect(screen.getByTestId('selected-members')).toHaveTextContent(/^10:10$/)

    const otherTeam: Team = {
      ...team,
      id: 2,
      name: 'another-agent',
      workflow: { mode: 'coordinate', leader_bot_id: '20' },
      bots: [{ bot_id: 20, role: 'leader', bot_prompt: '' }],
    }
    rerender(<TeamEditDialog {...props} editingTeamId={2} teams={[team, otherTeam]} />)
    expect(screen.getByRole('radio', { name: 'Coordinate' })).toBeChecked()
    expect(screen.getByTestId('selected-members')).toHaveTextContent(/^20:20$/)
    await act(async () => {})
  })

  it('cancels late solo initialization after changing collaboration mode', async () => {
    const team: Team = { ...existingTeam, bind_mode: ['chat'] }
    const props = { ...createProps(), editingTeamId: team.id, teams: [team] }
    const { rerender } = render(<TeamEditDialog {...props} bots={[]} />)
    fireEvent.click(screen.getByTestId('select-mode-label-pipeline'))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select members' }))

    rerender(<TeamEditDialog {...props} />)
    expect(screen.getByRole('radio', { name: 'Pipeline' })).toBeChecked()
    expect(screen.getByTestId('selected-members')).toHaveTextContent('20:20,10')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(updateTeam).toHaveBeenCalledWith(
        team.id,
        expect.objectContaining({ bind_mode: ['chat', 'code', 'task'] })
      )
    )
  })
})
