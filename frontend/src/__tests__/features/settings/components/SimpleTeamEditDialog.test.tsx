// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import { botApis } from '@/apis/bots'
import { modelApis } from '@/apis/models'
import { shellApis } from '@/apis/shells'
import { fetchUnifiedSkillsList } from '@/apis/skills'
import TeamEditDialog from '@/features/settings/components/TeamEditDialog'
import { createTeam, updateTeam } from '@/features/settings/services/teams'
import type { Bot, Team } from '@/types/api'
import type { ContextItem } from '@/types/context'

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
        'common:bot.default_contexts': 'Default contexts',
        'common:bot.default_contexts_add': 'Add context',
        'common:bot.default_contexts_empty': 'No default contexts selected',
        'common:bot.default_contexts_remove': 'Remove context',
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

jest.mock('@/features/tasks/components/chat/ContextSelector', () => ({
  __esModule: true,
  default: function MockContextSelector({
    children,
    onSelect,
  }: {
    children: ReactNode
    onSelect: (context: ContextItem) => void
  }) {
    return (
      <div>
        {children}
        <button
          type="button"
          onClick={() =>
            onSelect({
              type: 'knowledge_base',
              id: 10,
              name: 'Product Docs',
            })
          }
        >
          Add knowledge
        </button>
      </div>
    )
  },
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
          default_context_refs: [{ type: 'knowledge_base', id: 10, name: 'Product Docs' }],
          default_knowledge_base_refs: [{ type: 'knowledge_base', id: 10, name: 'Product Docs' }],
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
