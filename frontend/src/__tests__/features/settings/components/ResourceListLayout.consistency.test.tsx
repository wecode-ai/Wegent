// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'

import { modelApis } from '@/apis/models'
import { retrieverApis } from '@/apis/retrievers'
import { shellApis } from '@/apis/shells'
import ModelList from '@/features/settings/components/ModelList'
import RetrieverList from '@/features/settings/components/RetrieverList'
import ShellList from '@/features/settings/components/ShellList'
import type { Group } from '@/types/group'

jest.mock('@/apis/models', () => ({
  modelApis: {
    getUnifiedModels: jest.fn(),
    getModel: jest.fn(),
    testConnection: jest.fn(),
    deleteModel: jest.fn(),
  },
}))

jest.mock('@/apis/shells', () => {
  const actual = jest.requireActual('@/apis/shells')
  return {
    ...actual,
    shellApis: {
      ...actual.shellApis,
      getUnifiedShells: jest.fn(),
      deleteShell: jest.fn(),
    },
  }
})

jest.mock('@/apis/retrievers', () => ({
  retrieverApis: {
    getUnifiedRetrievers: jest.fn(),
    getRetriever: jest.fn(),
    testConnection: jest.fn(),
    deleteRetriever: jest.fn(),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: jest.fn(),
  }),
}))

const translations: Record<string, string> = {
  'common:models.title': 'Models',
  'common:models.description': 'Manage models.',
  'common:models.create': 'New Model',
  'common:models.test_connection': 'Test Connection',
  'common:models.test_success': 'Connection successful',
  'common:models.test_failed': 'Connection failed',
  'common:models.all_category_types': 'All',
  'models.all_category_types': 'All',
  'models.model_category_type_llm': 'LLM',
  'models.model_category_type_embedding': 'Embedding',
  'models.model_category_type_rerank': 'Rerank',
  'common:models.my_models': 'My Models',
  'common:models.public': 'Public',
  'common:models.group': 'Group',
  'common:models.group_models': 'Group Models',
  'common:models.public_models': 'System Models',
  'common:shells.title': 'Executors',
  'common:shells.description': 'Manage executors.',
  'common:shells.create': 'New Executor',
  'common:shells.my_shells': 'My Executors',
  'common:shells.public': 'Public',
  'common:shells.group': 'Group',
  'common:shells.group_shells': 'Group Executors',
  'common:shells.public_shells': 'System Executors',
  'common:retrievers.title': 'Retrievers',
  'common:retrievers.description': 'Manage retrievers.',
  'common:retrievers.create': 'New Retriever',
  'common:retrievers.my_retrievers': 'My Retrievers',
  'common:retrievers.group': 'Group',
  'retrievers.public': 'Public',
  'common:retrievers.group_retrievers': 'Group Retrievers',
  'retrievers.public_retrievers': 'System Retrievers',
  'actions.choose_create_target': 'Choose location',
  'actions.choose_create_target_description':
    'The save location controls who can see and manage this resource.',
  'targets.personal': 'My Resources',
  'targets.personal_description': 'Only you can see and manage it.',
  'targets.personal_section': 'Personal',
  'targets.group_description': 'Team members can see it and manage it by team permissions.',
  'targets.group_section': 'Team',
  'targets.select': 'Select',
  'search.groups_placeholder': 'Search teams',
  'search.groups_empty': 'No matching teams',
}

const mockT = (key: string) => translations[key] ?? key

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mockT,
  }),
}))

jest.mock('@/features/settings/components/ModelEditDialog', () => ({
  __esModule: true,
  default: ({ open }: { open?: boolean }) =>
    open ? <div data-testid="model-edit-dialog" /> : null,
}))

jest.mock('@/features/settings/components/ShellEditDialog', () => ({
  __esModule: true,
  default: ({ open }: { open?: boolean }) =>
    open ? <div data-testid="shell-edit-dialog" /> : null,
}))

jest.mock('@/features/settings/components/RetrieverEditDialog', () => ({
  __esModule: true,
  default: ({ open }: { open?: boolean }) =>
    open ? <div data-testid="retriever-edit-dialog" /> : null,
}))

const writableGroups: Group[] = [
  {
    id: 1,
    name: 'platform',
    display_name: 'Platform',
    parent_name: null,
    owner_user_id: 1,
    description: '',
    visibility: 'private',
    level: 'group',
    is_active: true,
    my_role: 'Owner',
    member_count: 1,
    created_at: '',
    updated_at: '',
  },
]

function sourceControls(): ReactNode {
  return <div data-testid="source-filter">Source</div>
}

describe('resource list layout consistency', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({
      data: [
        {
          name: 'personal-model',
          displayName: 'Personal Model',
          type: 'user',
          provider: 'openai',
          modelId: 'gpt-test',
          namespace: 'default',
          modelCategoryType: 'llm',
          config: { env: { model: 'openai', model_id: 'gpt-test', api_key: 'key' } },
        },
        {
          name: 'group-model',
          displayName: 'Group Model',
          type: 'group',
          provider: 'claude',
          modelId: 'claude-test',
          namespace: 'platform',
          modelCategoryType: 'embedding',
          config: { env: { model: 'claude', model_id: 'claude-test', api_key: 'key' } },
        },
        {
          name: 'system-model',
          displayName: 'System Model',
          type: 'public',
          provider: 'openai',
          modelId: 'system-test',
          namespace: 'system',
          modelCategoryType: 'rerank',
          config: { env: { model: 'openai', model_id: 'system-test' } },
        },
      ],
    })
    ;(shellApis.getUnifiedShells as jest.Mock).mockResolvedValue({
      data: [
        {
          name: 'personal-shell',
          displayName: 'Personal Executor',
          type: 'user',
          shellType: 'ClaudeCode',
          executionType: 'local_engine',
          namespace: 'default',
        },
        {
          name: 'group-shell',
          displayName: 'Group Executor',
          type: 'group',
          shellType: 'Chat',
          executionType: 'external_api',
          namespace: 'platform',
        },
      ],
    })
    ;(retrieverApis.getUnifiedRetrievers as jest.Mock).mockResolvedValue({
      data: [
        {
          name: 'personal-retriever',
          displayName: 'Personal Retriever',
          type: 'user',
          storageType: 'elasticsearch',
          namespace: 'default',
        },
        {
          name: 'group-retriever',
          displayName: 'Group Retriever',
          type: 'group',
          storageType: 'qdrant',
          namespace: 'platform',
        },
      ],
    })
  })

  it('places model creation and category filters above a flat model list', async () => {
    render(
      <ModelList
        scope="all"
        sourceFilter="all"
        sourceControls={sourceControls()}
        groups={writableGroups}
      />
    )

    await screen.findByText('Personal Model')

    const headerActions = screen.getByTestId('resource-page-header-actions')
    expect(within(headerActions).getByTestId('create-model-button')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

    const filterBar = screen.getByTestId('resource-page-filter-bar')
    expect(within(filterBar).getByTestId('source-filter')).toBeInTheDocument()
    expect(within(filterBar).getByTestId('model-category-filter')).toBeInTheDocument()
    expect(within(filterBar).getByTestId('model-category-filter-all')).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    const list = screen.getByTestId('model-list-items')
    expect(within(list).getByText('Personal Model')).toBeInTheDocument()
    expect(within(list).getByText('Group Model')).toBeInTheDocument()
    expect(within(list).getByText('System Model')).toBeInTheDocument()
    expect(screen.queryByText('My Models (1)')).not.toBeInTheDocument()
    expect(screen.queryByText('Group Models (1)')).not.toBeInTheDocument()
    expect(screen.queryByText('System Models (1)')).not.toBeInTheDocument()
  })

  it('tests a personal model from the full CRD instead of sanitized list config', async () => {
    const user = userEvent.setup()
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({
      data: [
        {
          name: 'personal-model',
          displayName: 'Personal Model',
          type: 'user',
          namespace: 'default',
          modelCategoryType: 'llm',
          config: {},
        },
      ],
    })
    ;(modelApis.getModel as jest.Mock).mockResolvedValue({
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Model',
      metadata: {
        name: 'personal-model',
        namespace: 'default',
        displayName: 'Personal Model',
      },
      spec: {
        modelType: 'llm',
        modelConfig: {
          env: {
            model: 'claude',
            model_id: 'deepseek-v4-flash',
            api_key: 'sk-secret',
            base_url: 'https://api.sensenova.cn/compatible-mode/v1',
            custom_headers: { 'x-test': 'enabled' },
          },
        },
      },
    })
    ;(modelApis.testConnection as jest.Mock).mockResolvedValue({
      success: true,
      message: 'ok',
    })

    render(
      <ModelList
        scope="all"
        sourceFilter="personal"
        sourceControls={sourceControls()}
        groups={writableGroups}
      />
    )

    await screen.findByText('Personal Model')
    await user.click(screen.getByTitle('Test Connection'))

    await waitFor(() => {
      expect(modelApis.getModel).toHaveBeenCalledWith('personal-model', 'default')
      expect(modelApis.testConnection).toHaveBeenCalledWith({
        provider_type: 'anthropic',
        model_id: 'deepseek-v4-flash',
        api_key: 'sk-secret',
        base_url: 'https://api.sensenova.cn/compatible-mode/v1',
        custom_headers: { 'x-test': 'enabled' },
        model_category_type: 'llm',
      })
    })
  })

  it('uses the same header action placement for executor and retriever lists', async () => {
    render(
      <ShellList
        scope="all"
        sourceFilter="all"
        sourceControls={sourceControls()}
        groups={writableGroups}
      />
    )

    await screen.findByText('Personal Executor')
    let headerActions = screen.getByTestId('resource-page-header-actions')
    expect(within(headerActions).getByTestId('create-shell-button')).toBeInTheDocument()
    expect(screen.getByTestId('resource-page-filter-bar')).toContainElement(
      screen.getByTestId('source-filter')
    )
    expect(screen.getByTestId('shell-list-items')).toBeInTheDocument()
    expect(screen.queryByText('My Executors (1)')).not.toBeInTheDocument()

    render(
      <RetrieverList
        scope="all"
        sourceFilter="all"
        sourceControls={sourceControls()}
        groups={writableGroups}
      />
    )

    await screen.findByText('Personal Retriever')
    headerActions = screen.getAllByTestId('resource-page-header-actions')[1]
    expect(within(headerActions).getByTestId('create-retriever-button')).toBeInTheDocument()
    expect(screen.getByTestId('retriever-list-items')).toBeInTheDocument()
    expect(screen.queryByText('My Retrievers (1)')).not.toBeInTheDocument()
  })
})
