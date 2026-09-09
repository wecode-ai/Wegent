// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import { botApis } from '@/apis/bots'
import { modelApis } from '@/apis/models'
import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { shellApis } from '@/apis/shells'
import { fetchUnifiedSkillsList } from '@/apis/skills'
import TeamEditDialog from '@/features/settings/components/TeamEditDialog'
import { createTeam, updateTeam } from '@/features/settings/services/teams'
import type { Bot, Team } from '@/types/api'
import type { Group } from '@/types/group'

const mockRefreshTeams = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'common:actions.cancel': 'Cancel',
        'common:actions.remove': 'Remove',
        'common:actions.save': 'Save',
        'common:actions.saving': 'Saving',
        'common:bot.agent_config': 'Model',
        'common:bot.default_knowledge_bases': 'Knowledge bases',
        'common:bot.fine_tune_prompt': 'Optimize',
        'common:bot.mcp_config': 'MCP',
        'common:bot.model_select': 'Select model',
        'common:bot.no_model_binding': 'No model',
        'common:bot.prompt': 'Prompt',
        'common:bot.prompt_placeholder': 'Prompt',
        'common:skills.loading_skills': 'Loading skills',
        'common:skills.manage_skills_button': 'Manage',
        'common:skills.preload_hint': 'Check skills to preload them.',
        'common:skills.preload_skills_section': 'Preload Skills',
        'common:skills.select_skill_to_add': 'Select skill',
        'common:skills.skills_section': 'Skills',
        'common:team.bind_mode': 'Bind mode',
        'common:team.description': 'Description',
        'common:team.description_placeholder': 'Description',
        'common:team.display_name': 'Display name',
        'common:team.display_name_placeholder': 'Display name',
        'common:team.name': 'Name',
        'common:team.name_placeholder': 'Agent name',
        'common:team.name_required': 'Agent name is required',
        'common:team.requires_workspace': 'Requires repository',
        'common:team.requires_workspace_hint': 'Common repository hint.',
        'settings:team.simple.advanced_toggle': 'Advanced mode',
        'settings:team.simple.advanced_toggle_description': 'Use full configuration.',
        'settings:team.simple.advanced_title': 'Advanced',
        'settings:team.simple.core.mcp_description': 'Connect MCP services.',
        'settings:team.simple.core.knowledge_description':
          'New chats start with these knowledge bases.',
        'settings:team.simple.core.model_description': 'Uses the default model when unset.',
        'settings:team.simple.core.prompt_description': 'Defines the agent behavior.',
        'settings:team.simple.core.skills_description': 'Adds tool capabilities.',
        'settings:team.simple.execution.bind_mode_description': 'Controls entry points.',
        'settings:team.simple.execution.executor_description': 'Controls runtime.',
        'settings:team.simple.execution.requires_workspace_description':
          'Settings repository hint.',
        'settings:team.simple.sections.basic': 'Basic settings',
        'settings:team.simple.sections.capability': 'Capabilities',
        'settings:team.simple.sections.execution': 'Mode settings',
        'settings:team.simple.sections.prompt': 'Prompt',
        'settings:team.simple.bind_mode.chat.description': 'Use for conversation.',
        'settings:team.simple.bind_mode.chat.title': 'Chat',
        'settings:team.simple.bind_mode.code.description': 'Use for repository tasks.',
        'settings:team.simple.bind_mode.code.title': 'Code',
        'settings:team.simple.bind_mode.task.description': 'Use for device tasks.',
        'settings:team.simple.bind_mode.task.title': 'Device',
        'settings:team.simple.executor.complex.description':
          'Complex executor for code tasks, device tasks, or multi-step complex tasks.',
        'settings:team.simple.executor.complex.title': 'Complex',
        'settings:team.simple.executor.custom.description': 'Use an executor you created.',
        'settings:team.simple.executor.custom.title': 'Custom',
        'settings:team.simple.executor.custom_shell_placeholder': 'Choose custom executor',
        'settings:team.simple.executor.manage_custom_shells_hint':
          'Manage custom executors in Resource Library - Executors.',
        'settings:team.simple.executor.no_custom_shells': 'No custom executors available',
        'settings:team.simple.executor.required': 'Choose executor',
        'settings:team.simple.executor.requires_complex_hint': 'Code requires complex.',
        'settings:team.simple.executor.simple.description': 'Chat executor.',
        'settings:team.simple.executor.simple.title': 'Simple',
        'settings:team.simple.executor.title': 'Executor',
        'settings:team.simple.non_solo_notice': 'This agent uses advanced collaboration.',
        'settings:team.simple.open_advanced': 'Open full configuration',
        'common:teams.create_title': 'Create agent',
        'common:teams.description': 'Agent settings',
        'common:teams.edit_title': 'Edit agent',
        'common:teams.force_edit_name': 'Force edit',
        'common:teams.force_identity_change': 'Confirm forced change',
        'common:teams.identity_change_confirm_title': 'Confirm identity change',
        'common:teams.identity_change_confirm_message': 'Existing references will stop working.',
        'common:teams.identity_change_warning': 'Existing references will stop working.',
        'common:teams.confirm_name_label': 'Enter the current technical name',
        'common:teams.private_scope_confirm_title': 'Confirm private scope',
        'common:teams.private_scope_confirm_message': 'Group members will lose access.',
        'common:teams.confirm_private_scope': 'Make private',
        'team.bind_mode_required': 'Select at least one mode',
        'team_model.solo': 'Solo',
      })[key] || key,
    i18n: { language: 'en' },
  }),
}))

jest.mock('@/features/settings/services/teams', () => ({
  createTeam: jest.fn(),
  updateTeam: jest.fn(),
}))

jest.mock('@/apis/bots', () => {
  const actual = jest.requireActual('@/apis/bots')
  return {
    ...actual,
    botApis: {
      ...actual.botApis,
      createBot: jest.fn(),
      updateBot: jest.fn(),
    },
  }
})

jest.mock('@/apis/models', () => ({
  modelApis: {
    getUnifiedModels: jest.fn(),
  },
}))

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    archiveListing: jest.fn(),
    bindAgent: jest.fn(),
    createListing: jest.fn(),
    getAgentBindings: jest.fn(),
    getMarketplaceTags: jest.fn(),
    getPublication: jest.fn(),
    syncAgentBindings: jest.fn(),
    updatePublication: jest.fn(),
  },
}))

jest.mock('@/apis/shells', () => {
  const actual = jest.requireActual('@/apis/shells')
  return {
    ...actual,
    shellApis: {
      ...actual.shellApis,
      getUnifiedShells: jest.fn(),
    },
  }
})

jest.mock('@/apis/skills', () => ({
  fetchUnifiedSkillsList: jest.fn(),
  fetchPublicSkillsList: jest.fn(),
}))

jest.mock('@/contexts/TeamContext', () => ({
  useTeamContext: () => ({
    refreshTeams: mockRefreshTeams,
  }),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

jest.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
}))

jest.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
  }: {
    checked?: boolean
    disabled?: boolean
    onCheckedChange?: (checked: boolean) => void
  }) => (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={event => onCheckedChange?.(event.target.checked)}
    />
  ),
}))

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

jest.mock('@/features/settings/components/teams/TeamIconPicker', () => ({
  TeamIconPicker: () => null,
}))

jest.mock('@/features/settings/components/TeamEditDrawer', () => () => null)
jest.mock('@/features/settings/components/team-edit/TeamModeChangeDialog', () => () => null)

jest.mock('@/features/settings/components/skills/RichSkillSelector', () => ({
  RichSkillSelector: ({
    skills,
    onSelectSkill,
  }: {
    skills: Array<{ name: string; id: number; namespace?: string; is_public?: boolean }>
    onSelectSkill: (skill: {
      name: string
      id: number
      namespace?: string
      is_public?: boolean
    }) => void
  }) => (
    <button
      type="button"
      onClick={() =>
        onSelectSkill({
          name: skills[0].name,
          id: 5,
          namespace: 'default',
          is_public: false,
        })
      }
    >
      Add skill
    </button>
  ),
}))

jest.mock('@/features/settings/components/skills/SkillManagementModal', () => () => null)
jest.mock('@/features/prompt-tune/components/PromptFineTuneDialog', () => () => null)
jest.mock('@/features/settings/components/knowledge/KnowledgeBaseMultiSelector', () => ({
  KnowledgeBaseMultiSelector: ({
    onChange,
  }: {
    onChange: (value: Array<{ id: number; name: string }>) => void
  }) => (
    <button type="button" onClick={() => onChange([{ id: 10, name: 'Product Docs' }])}>
      Add knowledge
    </button>
  ),
}))

jest.mock('@/features/settings/components/McpConfigSection', () => {
  function MockMcpConfigSection() {
    return <div data-testid="mcp-config-section" />
  }

  return MockMcpConfigSection
})

const mockedCreateBot = botApis.createBot as jest.Mock
const mockedUpdateBot = botApis.updateBot as jest.Mock
const mockedCreateTeam = createTeam as jest.Mock
const mockedUpdateTeam = updateTeam as jest.Mock
const mockedGetUnifiedShells = shellApis.getUnifiedShells as jest.Mock
const mockedGetUnifiedModels = modelApis.getUnifiedModels as jest.Mock
const mockedFetchUnifiedSkillsList = fetchUnifiedSkillsList as jest.Mock
const mockedArchiveListing = resourceLibraryApi.archiveListing as jest.Mock
const mockedBindAgent = resourceLibraryApi.bindAgent as jest.Mock
const mockedCreateListing = resourceLibraryApi.createListing as jest.Mock
const mockedGetAgentBindings = resourceLibraryApi.getAgentBindings as jest.Mock
const mockedGetMarketplaceTags = resourceLibraryApi.getMarketplaceTags as jest.Mock
const mockedGetPublication = resourceLibraryApi.getPublication as jest.Mock
const mockedSyncAgentBindings = resourceLibraryApi.syncAgentBindings as jest.Mock

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 10,
    name: 'existing-bot',
    namespace: 'default',
    shell_name: 'Chat',
    shell_type: 'Chat',
    agent_config: {},
    system_prompt: 'Existing prompt',
    mcp_servers: {},
    default_knowledge_base_refs: [],
    skills: [],
    is_active: true,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    ...overrides,
  }
}

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 1,
    name: 'agent',
    displayName: 'Agent',
    namespace: 'default',
    description: '',
    bots: [{ bot_id: 10, bot_prompt: '', role: 'leader' }],
    workflow: { mode: 'solo' },
    is_active: true,
    user_id: 1,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    bind_mode: ['chat'],
    ...overrides,
  }
}

describe('Simple TeamEditDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRefreshTeams.mockResolvedValue(undefined)
    mockedGetUnifiedShells.mockResolvedValue({
      data: [
        { name: 'Chat', type: 'public', displayName: 'Chat', shellType: 'Chat' },
        {
          name: 'ClaudeCode',
          type: 'public',
          displayName: 'Claude Code',
          shellType: 'ClaudeCode',
        },
      ],
    })
    mockedGetUnifiedModels.mockResolvedValue({
      data: [{ name: 'gpt-4.1', type: 'public', displayName: 'GPT 4.1', namespace: 'default' }],
    })
    mockedFetchUnifiedSkillsList.mockResolvedValue([
      {
        id: 5,
        name: 'repo-reader',
        displayName: 'Repo Reader',
        namespace: 'default',
        is_public: false,
      },
    ])
    mockedCreateBot.mockResolvedValue(makeBot({ id: 42, name: 'new-agent-bot' }))
    mockedCreateTeam.mockResolvedValue(makeTeam({ id: 99, name: 'new-agent' }))
    mockedUpdateBot.mockResolvedValue(makeBot())
    mockedUpdateTeam.mockResolvedValue(makeTeam())
    mockedBindAgent.mockResolvedValue({ id: 2 })
    mockedGetAgentBindings.mockResolvedValue({
      agent_id: 1,
      personal: true,
      group_names: [],
    })
    mockedSyncAgentBindings.mockResolvedValue({
      agent_id: 1,
      personal: true,
      group_names: [],
    })
    mockedArchiveListing.mockResolvedValue({ id: 1 })
    mockedCreateListing.mockResolvedValue({ id: 1 })
    mockedGetMarketplaceTags.mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'technical_development',
          zh_name: '技术开发',
          en_name: 'Technical Development',
          sort: 20,
          enabled: true,
        },
      ],
    })
    mockedGetPublication.mockResolvedValue({
      tags: ['technical_development'],
    })
  })

  it('defaults new agents to simple mode with chat bind mode selected', async () => {
    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[]}
        setTeams={jest.fn()}
        editingTeamId={0}
        bots={[]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    expect(await screen.findByRole('checkbox', { name: /chat/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /code/i })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /device/i })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /simple/i })).toBeChecked()
    const scrollContent = screen.getByTestId('team-edit-scroll-content')
    expect(scrollContent).toContainElement(screen.getByTestId('team-publish-scope-section'))
    expect(scrollContent).not.toContainElement(screen.getByRole('button', { name: /save/i }))
    expect(screen.getByTestId('capability-scope-personal')).toBeInTheDocument()
    expect(screen.getByTestId('capability-scope-team')).toBeInTheDocument()
    expect(screen.getByTestId('capability-scope-marketplace')).toBeInTheDocument()
  })

  it('shows example conversations when a new agent is first published to marketplace', async () => {
    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[]}
        setTeams={jest.fn()}
        editingTeamId={0}
        bots={[]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    fireEvent.click(await screen.findByTestId('capability-scope-marketplace'))

    expect(screen.getByTestId('team-marketplace-example-conversations-section')).toBeInTheDocument()
    expect(screen.getByTestId('team-marketplace-example-conversations-add')).toBeInTheDocument()
  })

  it('loads LLM models for the default chat bind mode', async () => {
    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[]}
        setTeams={jest.fn()}
        editingTeamId={0}
        bots={[]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    await waitFor(() => {
      expect(mockedGetUnifiedModels).toHaveBeenCalledWith(
        undefined,
        false,
        'personal',
        undefined,
        'llm'
      )
    })
  })

  it('shows and preserves an existing model that is no longer visible', async () => {
    const team = makeTeam()
    const hiddenModelBot = makeBot({
      agent_config: {
        bind_model: 'retired-model',
        bind_model_type: 'public',
        bind_model_namespace: 'default',
      },
    })

    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[team]}
        setTeams={jest.fn()}
        editingTeamId={team.id}
        bots={[hiddenModelBot]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    await waitFor(() => {
      expect(mockedGetUnifiedModels).toHaveBeenCalled()
      expect(screen.getByTestId('simple-model-select')).toHaveTextContent('retired-model')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockedUpdateBot).toHaveBeenCalledWith(
        hiddenModelBot.id,
        expect.objectContaining({
          agent_config: {
            bind_model: 'retired-model',
            bind_model_type: 'public',
          },
        })
      )
    })
  })

  it.each([
    { mode: 'image', category: 'image' },
    { mode: 'video', category: 'video' },
  ])('loads $category models for a $mode-only agent', async ({ mode, category }) => {
    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[]}
        setTeams={jest.fn()}
        editingTeamId={0}
        bots={[]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    await waitFor(() => {
      expect(mockedGetUnifiedModels).toHaveBeenCalledWith(
        undefined,
        false,
        'personal',
        undefined,
        'llm'
      )
    })

    fireEvent.click(screen.getByTestId('simple-bind-mode-chat-card'))
    fireEvent.click(screen.getByTestId('team-bind-mode-more-toggle'))
    fireEvent.click(screen.getByTestId(`simple-bind-mode-${mode}-card`))

    await waitFor(() => {
      expect(mockedGetUnifiedModels).toHaveBeenCalledWith(
        undefined,
        false,
        'personal',
        undefined,
        category
      )
    })
  })

  it('loads personal and target-team skills when creating a team agent', async () => {
    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[]}
        setTeams={jest.fn()}
        editingTeamId={0}
        bots={[]}
        setBots={jest.fn()}
        toast={jest.fn()}
        scope="group"
        groupName="engineering"
      />
    )

    await waitFor(() => {
      expect(mockedFetchUnifiedSkillsList).toHaveBeenCalledWith({ scope: 'personal' })
      expect(mockedFetchUnifiedSkillsList).toHaveBeenCalledWith({
        scope: 'group',
        groupName: 'engineering',
      })
    })
  })

  it('does not load team-only skills for a personal agent', async () => {
    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[]}
        setTeams={jest.fn()}
        editingTeamId={0}
        bots={[]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    await waitFor(() => {
      expect(mockedFetchUnifiedSkillsList).toHaveBeenCalledWith({ scope: 'personal' })
    })
    expect(mockedFetchUnifiedSkillsList).not.toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'all' })
    )
    expect(mockedFetchUnifiedSkillsList).not.toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'group' })
    )
  })

  it('uses settings-scoped text for the simple requires repository hint', async () => {
    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[]}
        setTeams={jest.fn()}
        editingTeamId={0}
        bots={[]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    fireEvent.click(await screen.findByRole('checkbox', { name: /code/i }))

    expect(await screen.findByText('Settings repository hint.')).toBeInTheDocument()
    expect(screen.queryByText('Common repository hint.')).not.toBeInTheDocument()
  })

  it('collapses and expands the basic settings section from its header', async () => {
    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[]}
        setTeams={jest.fn()}
        editingTeamId={0}
        bots={[]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    expect(await screen.findByLabelText(/^Name/)).toBeInTheDocument()

    const basicSectionTrigger = screen.getByTestId('simple-section-basic-trigger')
    expect(basicSectionTrigger).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(basicSectionTrigger)

    expect(basicSectionTrigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByLabelText(/^Name/)).not.toBeInTheDocument()

    fireEvent.click(basicSectionTrigger)

    expect(basicSectionTrigger).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByLabelText(/^Name/)).toBeInTheDocument()
  })

  it('saves a new simple solo agent through bot and team payloads', async () => {
    const onSaved = jest.fn().mockResolvedValue(undefined)

    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[]}
        setTeams={jest.fn()}
        editingTeamId={0}
        bots={[]}
        setBots={jest.fn()}
        toast={jest.fn()}
        onSaved={onSaved}
      />
    )

    await waitFor(() => expect(mockedGetUnifiedModels).toHaveBeenCalled())

    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'new-agent' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Add skill' }))
    fireEvent.click(await screen.findByTestId('simple-skill-preload-repo-reader'))
    fireEvent.click(screen.getByRole('button', { name: 'Add knowledge' }))
    fireEvent.change(screen.getByTestId('simple-prompt-textarea'), {
      target: { value: 'Answer with context.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockedCreateBot).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'new-agent-bot',
          shell_name: 'Chat',
          system_prompt: 'Answer with context.',
          skills: ['repo-reader'],
          preload_skills: ['repo-reader'],
          preload_skill_refs: {
            'repo-reader': {
              skill_id: 5,
              namespace: 'default',
              is_public: false,
            },
          },
          target_group_names: [],
          default_knowledge_base_refs: [{ id: 10, name: 'Product Docs' }],
        })
      )
      expect(mockedCreateTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'new-agent',
          workflow: { mode: 'solo', leader_bot_id: 42 },
          bind_mode: ['chat'],
          bots: [{ bot_id: 42, bot_prompt: '', role: 'leader' }],
        })
      )
      expect(onSaved).toHaveBeenCalled()
    })
  })

  it('lets an existing personal agent be distributed to a team', async () => {
    const team = makeTeam()
    const writableGroups = [
      {
        id: 7,
        name: 'engineering',
        display_name: 'Engineering',
        my_role: 'Developer',
      } as Group,
    ]

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
        writableGroups={writableGroups}
      />
    )

    fireEvent.click(await screen.findByTestId('capability-scope-team'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockedUpdateBot).toHaveBeenCalledWith(
        10,
        expect.objectContaining({
          target_group_names: ['engineering'],
        })
      )
      expect(mockedUpdateTeam).toHaveBeenCalled()
      expect(mockedSyncAgentBindings).toHaveBeenCalledWith(1, {
        group_names: ['engineering'],
      })
    })
  })

  it('confirms before removing all team publication bindings', async () => {
    const team = makeTeam()
    mockedGetAgentBindings.mockResolvedValueOnce({
      agent_id: team.id,
      personal: true,
      group_names: ['engineering'],
    })

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
      expect(screen.getByTestId('capability-scope-team')).toHaveAttribute('aria-pressed', 'true')
    })
    fireEvent.click(screen.getByTestId('capability-scope-personal'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Confirm private scope')).toBeInTheDocument()
    expect(mockedUpdateBot).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('confirm-team-private-scope'))

    await waitFor(() => {
      expect(mockedSyncAgentBindings).toHaveBeenCalledWith(team.id, {
        group_names: [],
      })
    })
  })

  it('confirms before removing one of multiple team publication bindings', async () => {
    const team = makeTeam()
    const writableGroups = [
      {
        id: 7,
        name: 'engineering',
        display_name: 'Engineering',
        my_role: 'Developer',
      } as Group,
      {
        id: 8,
        name: 'research',
        display_name: 'Research',
        my_role: 'Developer',
      } as Group,
    ]
    mockedGetAgentBindings.mockResolvedValueOnce({
      agent_id: team.id,
      personal: true,
      group_names: ['engineering', 'research'],
    })

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
        writableGroups={writableGroups}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('capability-scope-group-research')).toBeChecked()
    })
    fireEvent.click(screen.getByTestId('capability-scope-group-research'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Confirm private scope')).toBeInTheDocument()
    expect(mockedUpdateBot).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('confirm-team-private-scope'))

    await waitFor(() => {
      expect(mockedSyncAgentBindings).toHaveBeenCalledWith(team.id, {
        group_names: ['engineering'],
      })
    })
  })

  it('locks the technical name until forced and confirms a rename', async () => {
    const team = makeTeam()

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

    const nameInput = await screen.findByTestId('team-technical-name-input')
    expect(nameInput).toBeDisabled()

    fireEvent.click(screen.getByTestId('enable-team-technical-name-edit'))
    fireEvent.change(nameInput, { target: { value: 'renamed-agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(mockedUpdateBot).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('team-identity-confirmation-input'), {
      target: { value: team.name },
    })
    fireEvent.click(screen.getByTestId('confirm-team-identity-change'))

    await waitFor(() => {
      expect(mockedUpdateTeam).toHaveBeenCalledWith(
        team.id,
        expect.objectContaining({ name: 'renamed-agent' }),
        {
          forceIdentityChange: true,
          confirmName: team.name,
        }
      )
    })
  })

  it('locks the technical name again after the edit dialog is reopened', async () => {
    const team = makeTeam()
    const props = {
      onClose: jest.fn(),
      teams: [team],
      setTeams: jest.fn(),
      editingTeamId: team.id,
      bots: [makeBot()],
      setBots: jest.fn(),
      toast: jest.fn(),
    }
    const { rerender } = render(<TeamEditDialog {...props} open />)

    fireEvent.click(await screen.findByTestId('enable-team-technical-name-edit'))
    expect(screen.getByTestId('team-technical-name-input')).toBeEnabled()
    expect(screen.getByTestId('team-identity-change-warning')).toBeInTheDocument()

    rerender(<TeamEditDialog {...props} open={false} />)
    rerender(<TeamEditDialog {...props} open />)

    expect(await screen.findByTestId('team-technical-name-input')).toBeDisabled()
    expect(screen.queryByTestId('team-identity-change-warning')).not.toBeInTheDocument()
  })

  it('toggles the technical name lock and discards an unconfirmed rename', async () => {
    const team = makeTeam()

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

    const nameInput = await screen.findByTestId('team-technical-name-input')
    const lockButton = screen.getByTestId('enable-team-technical-name-edit')

    fireEvent.click(lockButton)
    fireEvent.change(nameInput, { target: { value: 'unconfirmed-name' } })
    fireEvent.click(lockButton)

    expect(nameInput).toBeDisabled()
    expect(nameInput).toHaveValue(team.name)
    expect(screen.queryByTestId('team-identity-change-warning')).not.toBeInTheDocument()
  })

  it('distributes an existing personal agent to multiple teams', async () => {
    const team = makeTeam()
    const writableGroups = [
      {
        id: 7,
        name: 'engineering',
        display_name: 'Engineering',
        my_role: 'Developer',
      } as Group,
      {
        id: 8,
        name: 'research',
        display_name: 'Research',
        my_role: 'Developer',
      } as Group,
    ]

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
        writableGroups={writableGroups}
      />
    )

    fireEvent.click(await screen.findByTestId('capability-scope-team'))
    fireEvent.click(screen.getByTestId('capability-scope-group-research'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockedUpdateBot).toHaveBeenCalledWith(
        10,
        expect.objectContaining({
          target_group_names: ['engineering', 'research'],
        })
      )
      expect(mockedSyncAgentBindings).toHaveBeenCalledWith(1, {
        group_names: ['engineering', 'research'],
      })
    })
  })

  it('loads all existing team bindings when editing an agent', async () => {
    const team = makeTeam({ namespace: 'default' })
    const writableGroups = [
      {
        id: 7,
        name: 'engineering',
        display_name: 'Engineering',
        my_role: 'Maintainer',
      } as Group,
      {
        id: 8,
        name: 'research',
        display_name: 'Research',
        my_role: 'Developer',
      } as Group,
    ]
    mockedGetAgentBindings.mockResolvedValueOnce({
      agent_id: team.id,
      personal: false,
      group_names: ['engineering', 'research'],
    })

    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[team]}
        setTeams={jest.fn()}
        editingTeamId={team.id}
        bots={[makeBot({ namespace: 'default' })]}
        setBots={jest.fn()}
        toast={jest.fn()}
        writableGroups={writableGroups}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('capability-scope-team')).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByTestId('capability-scope-group-engineering')).toBeChecked()
      expect(screen.getByTestId('capability-scope-group-research')).toBeChecked()
    })
  })

  it('preserves an existing personal skill when reopening a team-distributed agent', async () => {
    const team = makeTeam({ namespace: 'default' })
    const personalSkillRef = {
      skill_id: 92,
      namespace: 'default',
      is_public: false,
      content_hash: 'sha256:personal-skill',
    }
    mockedGetAgentBindings.mockResolvedValueOnce({
      agent_id: team.id,
      personal: false,
      group_names: ['engineering'],
    })

    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[team]}
        setTeams={jest.fn()}
        editingTeamId={team.id}
        bots={[
          makeBot({
            skills: ['h52wbox-cloud'],
            skill_refs: {
              'h52wbox-cloud': personalSkillRef,
            },
          }),
        ]}
        setBots={jest.fn()}
        toast={jest.fn()}
        writableGroups={[
          {
            id: 7,
            name: 'engineering',
            display_name: 'Engineering',
            my_role: 'Developer',
          } as Group,
        ]}
      />
    )

    await waitFor(() => {
      expect(mockedFetchUnifiedSkillsList).toHaveBeenCalledWith({
        scope: 'group',
        groupName: 'engineering',
      })
      expect(screen.getByText('h52wbox-cloud')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockedUpdateBot).toHaveBeenCalledWith(
        10,
        expect.objectContaining({
          skills: ['h52wbox-cloud'],
          skill_refs: {
            'h52wbox-cloud': personalSkillRef,
          },
          target_group_names: ['engineering'],
        })
      )
    })
  })

  it('lets an existing personal agent be published to the marketplace', async () => {
    const team = makeTeam()

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

    fireEvent.click(await screen.findByTestId('capability-scope-marketplace'))
    fireEvent.click(screen.getByTestId('team-marketplace-example-conversations-add'))
    fireEvent.change(screen.getByTestId('team-marketplace-example-conversations-title-0'), {
      target: { value: 'Example task' },
    })
    fireEvent.change(screen.getByTestId('team-marketplace-example-conversations-url-0'), {
      target: { value: 'https://example.com/shared/task' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockedCreateListing).toHaveBeenCalledWith(
        expect.objectContaining({
          resource_type: 'agent',
          source_id: 1,
          example_conversations: [
            {
              title: 'Example task',
              url: 'https://example.com/shared/task',
            },
          ],
        })
      )
      expect(mockedCreateListing.mock.calls[0][0]).not.toHaveProperty('name')
    })
  })

  it('closes after the agent is saved when marketplace publication fails', async () => {
    const team = makeTeam()
    const onClose = jest.fn()
    const toast = jest.fn()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockedCreateListing.mockRejectedValueOnce(new Error('Publication unavailable'))

    render(
      <TeamEditDialog
        open
        onClose={onClose}
        teams={[team]}
        setTeams={jest.fn()}
        editingTeamId={team.id}
        bots={[makeBot()]}
        setBots={jest.fn()}
        toast={toast}
      />
    )

    fireEvent.click(await screen.findByTestId('capability-scope-marketplace'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockedUpdateTeam).toHaveBeenCalled()
      expect(mockedCreateListing).toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
    })
    expect(toast).toHaveBeenCalledWith({
      variant: 'destructive',
      title: 'resource-library:messages.agent_saved_publication_failed',
    })
    consoleError.mockRestore()
  })

  it('lets a published team agent be distributed to personal scope', async () => {
    const team = makeTeam({ namespace: 'engineering', publication_status: 'published' })
    mockedUpdateTeam.mockResolvedValueOnce({ ...team, namespace: 'default' })

    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[team]}
        setTeams={jest.fn()}
        editingTeamId={team.id}
        bots={[makeBot({ namespace: 'engineering' })]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    fireEvent.click(await screen.findByTestId('capability-scope-personal'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.change(screen.getByTestId('team-identity-confirmation-input'), {
      target: { value: team.name },
    })
    fireEvent.click(screen.getByTestId('confirm-team-identity-change'))

    await waitFor(() => {
      expect(mockedUpdateTeam).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          namespace: 'default',
        }),
        {
          forceIdentityChange: true,
          confirmName: team.name,
        }
      )
      expect(mockedSyncAgentBindings).toHaveBeenCalledWith(1, {
        group_names: [],
      })
      expect(mockedBindAgent).not.toHaveBeenCalled()
      expect(mockedArchiveListing).toHaveBeenCalledWith(1)
    })
  })

  it('lets a team agent be published to the marketplace', async () => {
    const team = makeTeam({ namespace: 'engineering' })
    mockedUpdateTeam.mockResolvedValueOnce(team)

    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[team]}
        setTeams={jest.fn()}
        editingTeamId={team.id}
        bots={[makeBot({ namespace: 'engineering' })]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    fireEvent.click(await screen.findByTestId('capability-scope-marketplace'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockedCreateListing).toHaveBeenCalledWith(
        expect.objectContaining({
          resource_type: 'agent',
          source_id: 1,
        })
      )
      expect(mockedCreateListing.mock.calls[0][0]).not.toHaveProperty('name')
    })
  })

  it('saves preload skills when the simple form uses the Claude Code executor', async () => {
    render(
      <TeamEditDialog
        open
        onClose={jest.fn()}
        teams={[]}
        setTeams={jest.fn()}
        editingTeamId={0}
        bots={[]}
        setBots={jest.fn()}
        toast={jest.fn()}
      />
    )

    await waitFor(() => expect(mockedGetUnifiedModels).toHaveBeenCalled())

    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'code-agent' } })
    fireEvent.click(screen.getByTestId('simple-executor-complex-card'))
    fireEvent.click(await screen.findByRole('button', { name: 'Add skill' }))
    fireEvent.click(await screen.findByTestId('simple-skill-preload-repo-reader'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockedCreateBot).toHaveBeenCalledWith(
        expect.objectContaining({
          shell_name: 'ClaudeCode',
          skills: ['repo-reader'],
          preload_skills: ['repo-reader'],
          preload_skill_refs: {
            'repo-reader': {
              skill_id: 5,
              namespace: 'default',
              is_public: false,
            },
          },
        })
      )
    })
  })

  it('opens non-solo existing agents in the advanced path', async () => {
    const team = makeTeam({ workflow: { mode: 'pipeline' } })

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

    expect(await screen.findByText('This agent uses advanced collaboration.')).toBeInTheDocument()
    expect(screen.getByText('Solo')).toBeInTheDocument()
  })
})
