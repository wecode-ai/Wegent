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
import { shellApis } from '@/apis/shells'
import { fetchUnifiedSkillsList } from '@/apis/skills'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      const translations: Record<string, string> = {
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
      }

      const normalizedKey = key.startsWith('common:') ? key.replace(/^common:/, '') : key

      return translations[key] ?? translations[normalizedKey] ?? key
    },
    i18n: { language: 'en' },
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

jest.mock('@/apis/shells', () => ({
  shellApis: {
    getUnifiedShells: jest.fn(),
  },
}))

jest.mock('@/apis/skills', () => ({
  fetchUnifiedSkillsList: jest.fn(),
  fetchPublicSkillsList: jest.fn(),
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
  RichSkillSelector: function MockRichSkillSelector() {
    return <div data-testid="rich-skill-selector" />
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

function renderBotEdit() {
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
      scope="personal"
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

    mockedGetUnifiedShells.mockResolvedValue({
      data: [{ name: 'ClaudeCode', type: 'public', shellType: 'ClaudeCode' }],
    })
    mockedGetUnifiedModels.mockResolvedValue({
      data: [{ name: 'gpt-4.1', type: 'public', namespace: 'default' }],
    })
    mockedFetchUnifiedSkillsList.mockResolvedValue([])
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

  test('loads existing bot default knowledge bases into the form', async () => {
    renderBotEdit()

    expect(await screen.findByTestId('default-knowledge-base-chip-101')).toBeInTheDocument()
    expect(screen.getByText('Product Docs')).toBeInTheDocument()
  })

  test('renders popover-based selector with grouped metadata', async () => {
    renderBotEdit()

    fireEvent.click(await screen.findByTestId('default-knowledge-base-trigger'))

    expect(screen.queryByTestId('default-knowledge-base-selected-section')).not.toBeInTheDocument()
    expect(screen.queryByTestId('default-knowledge-base-available-section')).not.toBeInTheDocument()
    expect(screen.getByTestId('default-knowledge-base-popover')).toBeInTheDocument()
    expect(screen.getByTestId('default-knowledge-base-search-input')).toBeInTheDocument()

    expect(screen.getByTestId('default-knowledge-base-group-personal')).toBeInTheDocument()
    expect(screen.getByTestId('default-knowledge-base-group-group')).toBeInTheDocument()
    expect(screen.getByTestId('default-knowledge-base-group-organization')).toBeInTheDocument()

    expect(screen.getByText('Ops guides')).toBeInTheDocument()
    expect(screen.getByText('Company-wide security guidance')).toBeInTheDocument()
    expect(screen.getByText('Shared support answers')).toBeInTheDocument()
    expect(screen.getByText('Group')).toBeInTheDocument()
    expect(screen.getByText('Organization')).toBeInTheDocument()
    expect(screen.getByText('Shared')).toBeInTheDocument()
    expect(screen.getByText('Platform')).toBeInTheDocument()
    expect(screen.getByText('4 documents')).toBeInTheDocument()
    expect(screen.getByText('6 documents')).toBeInTheDocument()
    expect(screen.getAllByText(/Updated 2026-04-02/).length).toBeGreaterThan(0)
  })

  test('allows adding and removing multiple knowledge bases', async () => {
    renderBotEdit()

    fireEvent.click(await screen.findByTestId('default-knowledge-base-trigger'))

    const searchInput = await screen.findByTestId('default-knowledge-base-search-input')
    fireEvent.change(searchInput, { target: { value: 'Runbooks' } })

    fireEvent.click(await screen.findByTestId('default-knowledge-base-option-202'))

    expect(screen.getByTestId('default-knowledge-base-chip-101')).toBeInTheDocument()
    expect(screen.getByTestId('default-knowledge-base-chip-202')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('default-knowledge-base-remove-101'))

    await waitFor(() => {
      expect(screen.queryByTestId('default-knowledge-base-chip-101')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('default-knowledge-base-chip-202')).toBeInTheDocument()
  })

  test('includes default_knowledge_base_refs in save payload', async () => {
    renderBotEdit()

    fireEvent.click(await screen.findByTestId('default-knowledge-base-trigger'))

    const searchInput = await screen.findByTestId('default-knowledge-base-search-input')
    fireEvent.change(searchInput, { target: { value: 'Runbooks' } })
    fireEvent.click(await screen.findByTestId('default-knowledge-base-option-202'))

    fireEvent.click(screen.getByTestId('save-button'))

    await waitFor(() => {
      expect(mockedUpdateBot).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          default_knowledge_base_refs: [
            { id: 101, name: 'Product Docs' },
            { id: 202, name: 'Runbooks' },
          ],
        })
      )
    })
  })
})
