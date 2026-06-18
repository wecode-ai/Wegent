// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import BotEdit from '@/features/settings/components/BotEdit'
import { botApis } from '@/apis/bots'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { modelApis } from '@/apis/models'
import { publicResourceApis } from '@/apis/publicResources'
import { shellApis } from '@/apis/shells'
import { fetchPublicSkillsList, fetchUnifiedSkillsList } from '@/apis/skills'
import type { Bot } from '@/types/api'
import type { ContextItem } from '@/types/context'

const mockTranslate = (key: string, options?: { count?: number }) => {
  const translations: Record<string, string> = {
    'actions.delete': 'Delete',
    'bot.default_knowledge_bases': 'Default Knowledge Bases',
    'bot.default_knowledge_bases_search_placeholder': 'Search knowledge bases',
    'bot.default_knowledge_bases_used_for_new_chats':
      'Used to initialize knowledge bases for new chats.',
    'bot.default_knowledge_bases_append_hint':
      'Manual chat-time selection appends additional knowledge bases later.',
    'bot.default_knowledge_bases_selected_section': 'Selected default knowledge bases',
    'bot.default_knowledge_bases_available_section': 'Available knowledge bases',
    'bot.default_knowledge_bases_empty_selection': 'No default knowledge bases selected',
    'bot.default_knowledge_bases_no_options': 'No available knowledge bases',
    'bot.default_knowledge_bases_no_match': 'No matching knowledge bases',
    'bot.default_knowledge_bases_loading': 'Loading knowledge bases...',
    'bot.default_knowledge_bases_load_failed': 'Failed to load knowledge bases',
    'bot.default_knowledge_bases_updated_at': 'Updated',
    'bot.default_knowledge_bases_selected_badge': 'Selected',
    'bot.default_knowledge_bases_select_to_add': 'Select a knowledge base to add...',
    'bot.default_knowledge_bases_selected_count': `${options?.count ?? 0} selected`,
    'bot.default_knowledge_bases_group_personal': 'Personal knowledge bases',
    'bot.default_knowledge_bases_group_group': 'Group knowledge bases',
    'bot.default_knowledge_bases_group_organization': 'Organization knowledge bases',
    'bot.default_knowledge_bases_source_personal': 'Personal',
    'bot.default_knowledge_bases_source_group': 'Group',
    'bot.default_knowledge_bases_source_organization': 'Organization',
    'bot.default_knowledge_bases_source_shared': 'Shared',
    'knowledge:document_count': `${options?.count ?? 0} document`,
    'knowledge:documents_count': `${options?.count ?? 0} documents`,
    'skills.preload_hint': 'Check skills to preload them.',
    'skills.preload_skills_section': 'Preload Skills',
  }

  const normalizedKey = key.startsWith('common:') ? key.replace(/^common:/, '') : key

  return translations[key] ?? translations[normalizedKey] ?? key
}

const mockI18n = { language: 'en' }

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mockTranslate,
    i18n: mockI18n,
  }),
}))

jest.mock('@/apis/knowledge-base', () => ({
  knowledgeBaseApi: {
    getAllGrouped: jest.fn(),
  },
}))

jest.mock('@/apis/bots', () => {
  const actual = jest.requireActual('@/apis/bots')
  return {
    ...actual,
    botApis: {
      ...actual.botApis,
      updateBot: jest.fn(),
      createBot: jest.fn(),
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

jest.mock('@/apis/publicResources', () => ({
  publicResourceApis: {
    getPublicShells: jest.fn(),
    getPublicModels: jest.fn(),
    updatePublicBot: jest.fn(),
    createPublicBot: jest.fn(),
    getPublicBots: jest.fn(),
  },
}))

jest.mock('@/features/settings/components/McpConfigSection', () => {
  function MockMcpConfigSection() {
    return <div data-testid="mcp-config-section" />
  }

  return MockMcpConfigSection
})
jest.mock('@/features/settings/components/skills/SkillManagementModal', () => {
  function MockSkillManagementModal() {
    return null
  }

  return MockSkillManagementModal
})
jest.mock('@/features/settings/components/skills/RichSkillSelector', () => ({
  RichSkillSelector: function MockRichSkillSelector({
    skills,
  }: {
    skills: Array<{ name: string; displayName?: string }>
  }) {
    return (
      <div data-testid="rich-skill-selector">
        {skills.map(skill => (
          <span key={skill.name}>{skill.displayName || skill.name}</span>
        ))}
      </div>
    )
  },
}))
jest.mock('@/features/settings/components/DifyBotConfig', () => {
  function MockDifyBotConfig() {
    return null
  }

  return MockDifyBotConfig
})
jest.mock('@/features/prompt-tune/components/PromptFineTuneDialog', () => {
  function MockPromptFineTuneDialog() {
    return null
  }

  return MockPromptFineTuneDialog
})

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
      <div data-testid="default-context-selector">
        {children}
        <button
          type="button"
          data-testid="default-context-add-runbooks"
          onClick={() =>
            onSelect({
              type: 'knowledge_base',
              id: 202,
              name: 'Runbooks',
              document_count: 4,
            })
          }
        >
          Add Runbooks
        </button>
      </div>
    )
  },
}))

jest.mock('@/components/ui/select', () => ({
  Select: ({
    children,
    disabled,
  }: {
    value?: string
    onValueChange?: (value: string) => void
    children: ReactNode
    disabled?: boolean
  }) => (
    <div data-testid="mock-select" data-disabled={disabled ? 'true' : 'false'}>
      {children}
    </div>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <div data-testid={`mock-select-item-${value}`}>{children}</div>
  ),
}))

jest.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
  }: {
    checked?: boolean
    onCheckedChange?: (checked: boolean) => void
    disabled?: boolean
  }) => (
    <input
      data-testid="mock-switch"
      type="checkbox"
      checked={checked}
      onChange={event => onCheckedChange?.(event.target.checked)}
      disabled={disabled}
    />
  ),
}))

const mockedUpdateBot = botApis.updateBot as jest.Mock
const mockedKnowledgeBaseGrouped = knowledgeBaseApi.getAllGrouped as jest.Mock
const mockedGetUnifiedModels = modelApis.getUnifiedModels as jest.Mock
const mockedGetUnifiedShells = shellApis.getUnifiedShells as jest.Mock
const mockedFetchUnifiedSkillsList = fetchUnifiedSkillsList as jest.Mock
const mockedFetchPublicSkillsList = fetchPublicSkillsList as jest.Mock
const mockedGetPublicShells = publicResourceApis.getPublicShells as jest.Mock
const mockedGetPublicModels = publicResourceApis.getPublicModels as jest.Mock

function renderBotEdit(
  botOverrides: Partial<Bot> = {},
  props: { scope?: 'personal' | 'group' | 'all' | 'public'; groupName?: string } = {}
) {
  const bot = {
    id: 7,
    name: 'Bot Alpha',
    namespace: 'default',
    shell_name: 'ClaudeCode',
    shell_type: 'ClaudeCode',
    agent_config: {
      bind_model: 'gpt-4.1',
      bind_model_type: 'public',
    },
    system_prompt: 'helpful',
    mcp_servers: {},
    skills: [],
    default_knowledge_base_refs: [{ id: 101, name: 'Product Docs' }],
    is_active: true,
    created_at: '2026-04-02T00:00:00Z',
    updated_at: '2026-04-02T00:00:00Z',
    ...botOverrides,
  }

  const setBots = jest.fn()
  const onClose = jest.fn()
  const toast = jest.fn()

  render(
    <BotEdit
      bots={[bot]}
      setBots={setBots}
      editingBotId={7}
      cloningBot={null}
      onClose={onClose}
      toast={toast}
      scope={props.scope || 'personal'}
      groupName={props.groupName}
    />
  )

  return { setBots, onClose, toast }
}

describe('BotEdit default knowledge bases', () => {
  beforeEach(() => {
    mockedUpdateBot.mockReset()
    mockedKnowledgeBaseGrouped.mockReset()
    mockedGetUnifiedModels.mockReset()
    mockedGetUnifiedShells.mockReset()
    mockedFetchUnifiedSkillsList.mockReset()
    mockedFetchPublicSkillsList.mockReset()
    mockedGetPublicShells.mockReset()
    mockedGetPublicModels.mockReset()

    mockedGetUnifiedShells.mockResolvedValue({
      data: [{ name: 'ClaudeCode', type: 'public', shellType: 'ClaudeCode' }],
    })
    mockedGetPublicShells.mockResolvedValue([
      { name: 'ClaudeCode', type: 'public', shellType: 'ClaudeCode' },
      { name: 'Dify', type: 'public', shellType: 'Dify' },
    ])
    mockedGetUnifiedModels.mockResolvedValue({
      data: [{ name: 'gpt-4.1', type: 'public', namespace: 'default' }],
    })
    mockedGetPublicModels.mockResolvedValue([{ name: 'gpt-4.1', type: 'public' }])
    mockedFetchUnifiedSkillsList.mockResolvedValue([])
    mockedFetchPublicSkillsList.mockResolvedValue([])
    mockedKnowledgeBaseGrouped.mockResolvedValue({
      personal: {
        created_by_me: [
          {
            id: 101,
            name: 'Product Docs',
            description: 'Product references',
            kb_type: 'notebook',
            namespace: 'default',
            document_count: 3,
            updated_at: '2026-04-02T00:00:00Z',
            created_at: '2026-04-01T00:00:00Z',
            user_id: 7,
            group_id: 'default',
            group_name: 'Personal',
            group_type: 'personal',
          },
        ],
        shared_with_me: [
          {
            id: 404,
            name: 'Support FAQ',
            description: 'Shared support answers',
            kb_type: 'notebook',
            namespace: 'default',
            document_count: 2,
            updated_at: '2026-04-01T08:00:00Z',
            created_at: '2026-03-30T00:00:00Z',
            user_id: 9,
            group_id: 'default',
            group_name: 'Shared with me',
            group_type: 'personal-shared',
          },
        ],
      },
      groups: [
        {
          group_name: 'platform',
          group_display_name: 'Platform',
          kb_count: 1,
          knowledge_bases: [
            {
              id: 202,
              name: 'Runbooks',
              description: 'Ops guides',
              kb_type: 'notebook',
              namespace: 'platform',
              document_count: 4,
              updated_at: '2026-04-02T12:30:00Z',
              created_at: '2026-04-01T00:00:00Z',
              user_id: 8,
              group_id: 'platform',
              group_name: 'Platform',
              group_type: 'group',
            },
          ],
        },
        {
          group_name: 'growth',
          group_display_name: 'Growth',
          kb_count: 1,
          knowledge_bases: [
            {
              id: 505,
              name: 'Growth Playbooks',
              description: 'Growth experiments',
              kb_type: 'notebook',
              namespace: 'growth',
              document_count: 5,
              updated_at: '2026-04-02T13:30:00Z',
              created_at: '2026-04-01T00:00:00Z',
              user_id: 10,
              group_id: 'growth',
              group_name: 'Growth',
              group_type: 'group',
            },
          ],
        },
      ],
      organization: {
        namespace: 'org',
        display_name: 'Organization',
        kb_count: 1,
        knowledge_bases: [
          {
            id: 303,
            name: 'Security Policies',
            description: 'Company-wide security guidance',
            kb_type: 'classic',
            namespace: 'org',
            document_count: 6,
            updated_at: '2026-04-03T09:00:00Z',
            created_at: '2026-04-01T00:00:00Z',
            user_id: 1,
            group_id: 'org',
            group_name: 'Organization',
            group_type: 'organization',
          },
        ],
      },
      summary: {
        total_count: 3,
        personal_count: 1,
        group_count: 1,
        organization_count: 1,
      },
    })
    mockedUpdateBot.mockResolvedValue({
      id: 7,
      name: 'Bot Alpha',
      namespace: 'default',
      shell_name: 'ClaudeCode',
      shell_type: 'ClaudeCode',
      agent_config: {
        bind_model: 'gpt-4.1',
        bind_model_type: 'public',
      },
      system_prompt: 'helpful',
      mcp_servers: {},
      skills: [],
      default_knowledge_base_refs: [{ id: 101, name: 'Product Docs' }],
      is_active: true,
      created_at: '2026-04-02T00:00:00Z',
      updated_at: '2026-04-02T00:00:00Z',
    })
  })

  test('loads existing bot default contexts into the form', async () => {
    renderBotEdit()

    expect(await screen.findByText('Product Docs')).toBeInTheDocument()
  })

  test('renders selected hidden skill display name without exposing it as selectable', async () => {
    mockedFetchUnifiedSkillsList.mockResolvedValue([
      {
        id: 909,
        name: 'interactive-form-question',
        namespace: 'default',
        description: 'Hidden skill',
        displayName: '交互式表单提问',
        visible: false,
        is_active: true,
        is_public: true,
        user_id: 0,
      },
    ])

    renderBotEdit({
      skills: ['interactive-form-question'],
      skill_refs: {
        'interactive-form-question': {
          skill_id: 909,
          namespace: 'default',
          is_public: true,
        },
      },
    })

    expect(await screen.findByText('交互式表单提问')).toBeInTheDocument()
    expect(screen.queryByTestId('rich-skill-selector')).not.toBeInTheDocument()
  })

  test('shows preload controls for selected Claude Code skills', async () => {
    mockedFetchUnifiedSkillsList.mockResolvedValue([
      {
        id: 5,
        name: 'repo-reader',
        namespace: 'default',
        description: 'Read repository context',
        displayName: 'Repo Reader',
        visible: true,
        is_active: true,
        is_public: false,
        user_id: 7,
      },
    ])

    renderBotEdit({
      skills: ['repo-reader'],
      skill_refs: {
        'repo-reader': {
          skill_id: 5,
          namespace: 'default',
          is_public: false,
        },
      },
    })

    expect((await screen.findAllByText('Repo Reader')).length).toBeGreaterThan(0)
    expect(screen.getByTitle('Preload Skills')).toBeInTheDocument()
    expect(screen.getByText('Check skills to preload them.')).toBeInTheDocument()
  })

  test('shows hidden public skills as selectable when editing public bots', async () => {
    mockedFetchPublicSkillsList.mockResolvedValue([
      {
        id: 910,
        name: 'hidden-public-skill',
        namespace: 'default',
        description: 'Hidden public skill',
        displayName: '隐藏公共技能',
        visible: false,
        is_active: true,
        is_public: true,
        user_id: 0,
      },
    ])

    renderBotEdit({}, { scope: 'public' })

    expect(await screen.findByTestId('rich-skill-selector')).toBeInTheDocument()
    expect(screen.getByText('隐藏公共技能')).toBeInTheDocument()
  })

  test('hides knowledge base selector for public Dify bots', async () => {
    renderBotEdit(
      {
        shell_name: 'Dify',
        shell_type: 'Dify',
        agent_config: {},
      },
      { scope: 'public' }
    )

    await waitFor(() => {
      expect(mockedGetPublicShells).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('default-context-selector')).not.toBeInTheDocument()
  })

  test('shows default context selector for public non-Dify bots', async () => {
    renderBotEdit({}, { scope: 'public' })

    expect(await screen.findByTestId('default-context-selector')).toBeInTheDocument()
  })

  test('shows default context selector for group bots', async () => {
    renderBotEdit(
      {
        namespace: 'platform',
        default_knowledge_base_refs: [],
      },
      { scope: 'group', groupName: 'platform' }
    )

    expect(await screen.findByTestId('default-context-selector')).toBeInTheDocument()
  })

  test('renders the default context selector', async () => {
    renderBotEdit()

    expect(await screen.findByText('Default Knowledge Bases')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Select a knowledge base to add...' })
    ).toBeInTheDocument()
  })

  test('allows adding and removing multiple default contexts', async () => {
    renderBotEdit()
    await waitFor(() => expect(mockedGetUnifiedModels).toHaveBeenCalled())

    fireEvent.click(await screen.findByTestId('default-context-add-runbooks'))

    expect(screen.getByText('Product Docs')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('Runbooks')).toBeInTheDocument()
    })

    fireEvent.click(screen.getAllByLabelText('Delete')[0])

    await waitFor(() => {
      expect(screen.queryByText('Product Docs')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Runbooks')).toBeInTheDocument()
  })

  test('includes default context refs in save payload', async () => {
    renderBotEdit()
    await waitFor(() => expect(mockedGetUnifiedModels).toHaveBeenCalled())
    expect(await screen.findByText('Product Docs')).toBeInTheDocument()

    fireEvent.click(await screen.findByTestId('default-context-add-runbooks'))
    await waitFor(() => {
      expect(screen.getByText('Runbooks')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('save-button'))

    await waitFor(() => {
      expect(mockedUpdateBot).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          default_context_refs: [
            {
              type: 'knowledge_base',
              id: 101,
              name: 'Product Docs',
              document_count: undefined,
            },
            { type: 'knowledge_base', id: 202, name: 'Runbooks', document_count: 4 },
          ],
          default_knowledge_base_refs: [
            {
              type: 'knowledge_base',
              id: 101,
              name: 'Product Docs',
              document_count: undefined,
            },
            { type: 'knowledge_base', id: 202, name: 'Runbooks', document_count: 4 },
          ],
        })
      )
    })
  })

  test('preserves hidden external default contexts when saving with DingTalk disabled', async () => {
    renderBotEdit({
      default_context_refs: [
        {
          type: 'knowledge_base',
          id: 101,
          name: 'Product Docs',
        },
        {
          type: 'external_document',
          id: 'docs:node-1',
          provider: 'dingtalk',
          source: 'docs',
          name: 'DingTalk Spec',
          metadata: { external_id: 'node-1' },
        },
      ],
      default_knowledge_base_refs: [{ id: 101, name: 'Product Docs' }],
    })
    await waitFor(() => expect(mockedGetUnifiedModels).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('save-button'))

    await waitFor(() => {
      expect(mockedUpdateBot).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          default_context_refs: [
            {
              type: 'knowledge_base',
              id: 101,
              name: 'Product Docs',
              document_count: undefined,
            },
            {
              type: 'external_document',
              id: 'docs:node-1',
              provider: 'dingtalk',
              source: 'docs',
              name: 'DingTalk Spec',
              metadata: { external_id: 'node-1' },
            },
          ],
        })
      )
    })
  })
})
