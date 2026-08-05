// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'

import { modelApis } from '@/apis/models'
import { resourceLibraryApi } from '@/apis/resourceLibrary'
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

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    uninstallListing: jest.fn(),
    getReferenceUsage: jest.fn(),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: (() => {
    const toast = jest.fn()
    return () => ({ toast })
  })(),
}))

const translations: Record<string, string> = {
  'common:models.title': 'Models',
  'common:models.description': 'Manage models.',
  'common:models.create': 'New Model',
  'common:models.edit': 'Edit Model',
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
  'common:shells.edit': 'Edit Executor',
  'common:shells.my_shells': 'My Executors',
  'common:shells.public': 'Public',
  'common:shells.group': 'Group',
  'common:shells.group_shells': 'Group Executors',
  'common:shells.public_shells': 'System Executors',
  'common:retrievers.title': 'Retrievers',
  'common:retrievers.description': 'Manage retrievers.',
  'common:retrievers.create': 'New Retriever',
  'common:retrievers.edit': 'Edit Retriever',
  'common:retrievers.test_connection': 'Test Connection',
  'common:retrievers.my_retrievers': 'My Retrievers',
  'common:retrievers.group': 'Group',
  'retrievers.public': 'Public',
  'common:retrievers.group_retrievers': 'Group Retrievers',
  'retrievers.public_retrievers': 'System Retrievers',
  'common:actions.edit': 'Edit',
  'common:actions.unbind': 'Unbind',
  'common:actions.unbinding': 'Unbinding...',
  'common:actions.unbind_success': 'Unbound successfully',
  'common:actions.unbind_failed': 'Failed to unbind',
  'common:actions.unbind_in_use_title': 'Unable to unbind',
  'common:actions.unbind_shell_in_use_message': 'This executor is used by: {{names}}.',
  'common:actions.unbind_shell_in_use_prefix': 'This executor is used by: ',
  'common:actions.unbind_shell_in_use_suffix': '.',
  'common:actions.unbind_shell_in_use_summary': 'Used by {{count}} agents:',
  'common:actions.unbind_shell_in_use_guidance': 'Change their executor first.',
  'common:actions.unbind_retriever_in_use_message': 'This retriever is used by: {{names}}.',
  'common:actions.unbind_retriever_in_use_prefix': 'This retriever is used by: ',
  'common:actions.unbind_retriever_in_use_suffix': '.',
  'common:actions.unbind_retriever_in_use_summary': 'Used by {{count}} knowledge bases:',
  'common:actions.unbind_retriever_in_use_guidance': 'Change their retriever first.',
  'common:actions.go_to_agents': 'Go to agents',
  'common:actions.go_to_knowledge_bases': 'Go to knowledge bases',
  'common:actions.unbind_confirm_title': 'Confirm unbind',
  'common:actions.unbind_confirm_message': 'The original resource will not be affected.',
  'common:actions.got_it': 'Got it',
  'common:actions.cancel': 'Cancel',
  'common:actions.more_actions': 'More actions',
  'common:teams.more_actions': 'More actions',
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

const mockT = (key: string, options?: Record<string, unknown>) =>
  (translations[key] ?? key)
    .replace('{{names}}', String(options?.names ?? ''))
    .replace('{{count}}', String(options?.count ?? ''))

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
    ;(resourceLibraryApi.getReferenceUsage as jest.Mock).mockResolvedValue({
      referenced_bots: [],
      referenced_knowledge_bases: [],
    })
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

  it('uses the shared responsive card grid only in compact resource-library views', async () => {
    const gridClass = 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
    const modelView = render(
      <ModelList scope="all" sourceFilter="all" groups={writableGroups} compact />
    )

    await screen.findByText('Personal Model')
    expect(screen.getByTestId('model-list-items')).toHaveClass('grid', gridClass)
    const modelCard = screen.getByTestId('model-card-user-personal-model')
    expect(modelCard.className).not.toContain('min-h-[')
    const modelActions = within(modelCard).getByTestId('model-card-actions-user-personal-model')
    const testModelButton = within(modelActions).getByTestId('test-model-personal-model-button')
    const editModelButton = within(modelActions).getByTestId('edit-model-personal-model-button')
    const modelMoreButton = within(modelActions).getByTestId(
      'model-more-actions-personal-model-button'
    )
    expect(testModelButton).toHaveAccessibleName('Test Connection')
    expect(editModelButton).toHaveAccessibleName('Edit Model')
    expect(editModelButton).toHaveTextContent('Edit')
    expect(testModelButton).toHaveClass('h-11', 'w-11', 'md:h-8', 'md:w-8')
    expect(editModelButton).toHaveClass('h-11', 'flex-1', 'md:h-8')
    expect(modelMoreButton).toHaveClass('h-11', 'w-11', 'md:h-8', 'md:w-8')
    expect(modelActions).toHaveClass('border-t', 'mt-auto')
    expect(within(modelCard).queryByTestId('resource-list-item-actions')).toBeNull()
    expect(screen.queryByTestId('model-management-title')).not.toBeInTheDocument()
    modelView.unmount()

    const shellView = render(
      <ShellList scope="all" sourceFilter="all" groups={writableGroups} compact />
    )

    await screen.findByText('Personal Executor')
    expect(screen.getByTestId('shell-list-items')).toHaveClass('grid', gridClass)
    const shellCard = screen.getByTestId('shell-card-user-personal-shell')
    expect(shellCard.className).not.toContain('min-h-[')
    const shellActions = within(shellCard).getByTestId('shell-card-actions-user-personal-shell')
    const editShellButton = within(shellActions).getByTestId('edit-shell-personal-shell-button')
    const shellMoreButton = within(shellActions).getByTestId(
      'shell-more-actions-personal-shell-button'
    )
    expect(editShellButton).toHaveAccessibleName('Edit Executor')
    expect(editShellButton).toHaveTextContent('Edit')
    expect(editShellButton).toHaveClass('h-11', 'flex-1', 'md:h-8')
    expect(shellMoreButton).toHaveClass('h-11', 'w-11', 'md:h-8', 'md:w-8')
    expect(shellActions).toHaveClass('border-t', 'mt-auto')
    expect(within(shellCard).queryByTestId('resource-list-item-actions')).toBeNull()
    shellView.unmount()

    render(<RetrieverList scope="all" sourceFilter="all" groups={writableGroups} compact />)

    await screen.findByText('Personal Retriever')
    expect(screen.getByTestId('retriever-list-items')).toHaveClass('grid', gridClass)
    const retrieverCard = screen.getByTestId('retriever-card-user-personal-retriever')
    expect(retrieverCard.className).not.toContain('min-h-[')
    const retrieverActions = within(retrieverCard).getByTestId(
      'retriever-card-actions-user-personal-retriever'
    )
    const testRetrieverButton = within(retrieverActions).getByTestId(
      'test-retriever-personal-retriever-button'
    )
    const editRetrieverButton = within(retrieverActions).getByTestId(
      'edit-retriever-personal-retriever-button'
    )
    const retrieverMoreButton = within(retrieverActions).getByTestId(
      'retriever-more-actions-personal-retriever-button'
    )
    expect(testRetrieverButton).toHaveAccessibleName('Test Connection')
    expect(editRetrieverButton).toHaveAccessibleName('Edit Retriever')
    expect(editRetrieverButton).toHaveTextContent('Edit')
    expect(testRetrieverButton).toHaveClass('h-11', 'w-11', 'md:h-8', 'md:w-8')
    expect(editRetrieverButton).toHaveClass('h-11', 'flex-1', 'md:h-8')
    expect(retrieverMoreButton).toHaveClass('h-11', 'w-11', 'md:h-8', 'md:w-8')
    expect(retrieverActions).toHaveClass('border-t', 'mt-auto')
    expect(within(retrieverCard).queryByTestId('resource-list-item-actions')).toBeNull()
  })

  it('shrinks a read-only system model card without duplicate metadata or empty actions', async () => {
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({
      data: [
        {
          name: 'ali-deepseek-v4-flash',
          type: 'public',
          provider: 'anthropic',
          modelId: 'ali-deepseek-v4-flash',
          namespace: 'system',
          modelCategoryType: 'llm',
          config: { env: { model: 'anthropic', model_id: 'ali-deepseek-v4-flash' } },
        },
      ],
    })

    render(<ModelList scope="all" sourceFilter="system" compact hideCreateActions />)

    const card = await screen.findByTestId('model-card-public-ali-deepseek-v4-flash')
    expect(card).not.toHaveClass('min-h-[176px]')
    expect(within(card).queryByTestId('model-card-actions-public-ali-deepseek-v4-flash')).toBeNull()
    expect(within(card).getByTestId('resource-card-icon')).toHaveClass(
      'h-11',
      'w-11',
      'rounded-xl',
      'border'
    )
    expect(within(card).getAllByText('ali-deepseek-v4-flash')).toHaveLength(1)
  })

  it('omits empty actions and uses the shared icon container for system executors and retrievers', async () => {
    ;(shellApis.getUnifiedShells as jest.Mock).mockResolvedValue({
      data: [
        {
          name: 'system-shell',
          displayName: 'System Executor',
          type: 'public',
          shellType: 'Chat',
          executionType: 'external_api',
          namespace: 'system',
        },
      ],
    })
    ;(retrieverApis.getUnifiedRetrievers as jest.Mock).mockResolvedValue({
      data: [
        {
          name: 'system-retriever',
          displayName: 'System Retriever',
          type: 'public',
          storageType: 'elasticsearch',
          namespace: 'system',
        },
      ],
    })

    const shellView = render(
      <ShellList scope="all" sourceFilter="system" compact hideCreateActions />
    )
    const shellCard = await screen.findByTestId('shell-card-public-system-shell')
    expect(shellCard).not.toHaveClass('min-h-[176px]')
    expect(within(shellCard).queryByTestId('shell-card-actions-public-system-shell')).toBeNull()
    expect(within(shellCard).getByTestId('resource-card-icon')).toHaveClass('h-11', 'w-11')
    shellView.unmount()

    render(<RetrieverList scope="all" sourceFilter="system" compact hideCreateActions />)
    const retrieverCard = await screen.findByTestId('retriever-card-public-system-retriever')
    expect(retrieverCard).not.toHaveClass('min-h-[176px]')
    expect(
      within(retrieverCard).queryByTestId('retriever-card-actions-public-system-retriever')
    ).toBeNull()
    expect(within(retrieverCard).getByTestId('resource-card-icon')).toHaveClass('h-11', 'w-11')
  })

  it('offers only unbind for installed foundation resource references', async () => {
    const user = userEvent.setup()
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({
      data: [
        {
          name: 'installed-model',
          displayName: 'Installed Model',
          type: 'user',
          namespace: 'default',
          modelCategoryType: 'llm',
          config: {},
          isReference: true,
          listingId: 91,
        },
      ],
    })
    ;(shellApis.getUnifiedShells as jest.Mock).mockResolvedValue({
      data: [
        {
          name: 'installed-shell',
          displayName: 'Installed Executor',
          type: 'user',
          shellType: 'Chat',
          namespace: 'default',
          isReference: true,
          listingId: 92,
        },
      ],
    })
    ;(retrieverApis.getUnifiedRetrievers as jest.Mock).mockResolvedValue({
      data: [
        {
          name: 'installed-retriever',
          displayName: 'Installed Retriever',
          type: 'user',
          storageType: 'elasticsearch',
          namespace: 'default',
          isReference: true,
          listingId: 93,
        },
      ],
    })

    const modelView = render(<ModelList scope="personal" compact />)
    const modelCard = await screen.findByTestId('model-card-user-installed-model')
    const unbindModelButton = within(modelCard).getByTestId('unbind-model-installed-model-button')
    expect(unbindModelButton).toHaveTextContent('Unbind')
    expect(unbindModelButton).toHaveClass('flex-1')
    expect(within(modelCard).queryByTestId('model-more-actions-installed-model-button')).toBeNull()
    modelView.unmount()

    const shellView = render(<ShellList scope="personal" compact />)
    const shellCard = await screen.findByTestId('shell-card-user-installed-shell')
    expect(within(shellCard).queryByTestId('shell-more-actions-installed-shell-button')).toBeNull()
    await user.click(within(shellCard).getByTestId('unbind-shell-installed-shell-button'))
    await user.click(screen.getByRole('button', { name: 'Unbind' }))
    await waitFor(() => {
      expect(resourceLibraryApi.uninstallListing).toHaveBeenCalledWith(92, 'default')
    })
    shellView.unmount()

    render(<RetrieverList scope="personal" compact />)
    const retrieverCard = await screen.findByTestId('retriever-card-user-installed-retriever')
    expect(
      within(retrieverCard).queryByTestId('retriever-more-actions-installed-retriever-button')
    ).toBeNull()
    expect(
      within(retrieverCard).getByTestId('unbind-retriever-installed-retriever-button')
    ).toHaveTextContent('Unbind')
  })

  it('shows knowledge base usage before unbinding an installed retriever', async () => {
    const user = userEvent.setup()
    ;(retrieverApis.getUnifiedRetrievers as jest.Mock).mockResolvedValue({
      data: [
        {
          name: 'installed-retriever',
          displayName: 'Installed Retriever',
          type: 'user',
          storageType: 'elasticsearch',
          namespace: 'default',
          isReference: true,
          listingId: 93,
        },
      ],
    })
    ;(resourceLibraryApi.getReferenceUsage as jest.Mock).mockResolvedValue({
      referenced_bots: [],
      referenced_knowledge_bases: [
        {
          id: 166,
          name: 'Knowledge Base Using Marketplace Retriever',
          namespace: 'default',
        },
      ],
    })

    render(<RetrieverList scope="personal" compact />)
    const retrieverCard = await screen.findByTestId('retriever-card-user-installed-retriever')
    await user.click(
      within(retrieverCard).getByTestId('unbind-retriever-installed-retriever-button')
    )

    expect(resourceLibraryApi.getReferenceUsage).toHaveBeenCalledWith(93, 'default')
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Knowledge Base Using Marketplace Retriever'
    )
    expect(screen.getByText('Used by 1 knowledge bases:')).toBeInTheDocument()
    expect(screen.getByText('Knowledge Base Using Marketplace Retriever')).toHaveClass(
      'font-semibold'
    )
    expect(screen.getByRole('link', { name: 'Go to knowledge bases' })).toHaveAttribute(
      'href',
      '/knowledge?type=document'
    )
    expect(screen.queryByRole('button', { name: 'Unbind' })).not.toBeInTheDocument()
  })

  it('shows agent usage before unbinding an installed executor', async () => {
    const user = userEvent.setup()
    ;(shellApis.getUnifiedShells as jest.Mock).mockResolvedValue({
      data: [
        {
          name: 'installed-shell',
          displayName: 'Installed Executor',
          type: 'user',
          shellType: 'Chat',
          namespace: 'default',
          isReference: true,
          listingId: 92,
        },
      ],
    })
    ;(resourceLibraryApi.getReferenceUsage as jest.Mock).mockResolvedValue({
      referenced_bots: [
        {
          id: 25,
          name: 'Agent Using Marketplace Executor',
          namespace: 'default',
        },
      ],
      referenced_knowledge_bases: [],
    })

    render(<ShellList scope="personal" compact />)
    const shellCard = await screen.findByTestId('shell-card-user-installed-shell')
    await user.click(within(shellCard).getByTestId('unbind-shell-installed-shell-button'))

    expect(resourceLibraryApi.getReferenceUsage).toHaveBeenCalledWith(92, 'default')
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Agent Using Marketplace Executor')
    expect(screen.getByText('Used by 1 agents:')).toBeInTheDocument()
    expect(screen.getByText('Agent Using Marketplace Executor')).toHaveClass('font-semibold')
    expect(screen.getByRole('link', { name: 'Go to agents' })).toHaveAttribute(
      'href',
      '/resource-library?type=agent&tab=mine'
    )
    expect(screen.queryByRole('button', { name: 'Unbind' })).not.toBeInTheDocument()
  })

  it('does not repeat public source or executor type metadata', async () => {
    ;(shellApis.getUnifiedShells as jest.Mock).mockResolvedValue({
      data: [
        {
          name: 'Chat',
          type: 'public',
          shellType: 'Chat',
          executionType: 'external_api',
          namespace: 'system',
        },
      ],
    })

    render(<ShellList scope="all" sourceFilter="system" compact hideCreateActions />)

    const card = await screen.findByTestId('shell-card-public-Chat')
    expect(within(card).getAllByText('Public')).toHaveLength(1)
    expect(within(card).getAllByText('Chat')).toHaveLength(1)
  })
})
