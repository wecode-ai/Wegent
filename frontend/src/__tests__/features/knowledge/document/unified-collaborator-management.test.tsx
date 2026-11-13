// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KnowledgeDocumentPageDesktop } from '@/features/knowledge/document/components/KnowledgeDocumentPageDesktop'
import { KnowledgeDocumentPageMobile } from '@/features/knowledge/document/components/KnowledgeDocumentPageMobile'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { createKnowledgeBase, getKnowledgeBase } from '@/apis/knowledge'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import { codeWikiApi } from '@/apis/code-wiki'
import type {
  AllGroupedKnowledgeResponse,
  KnowledgeBase,
  KnowledgeBaseWithGroupInfo,
} from '@/types/knowledge'

const mockPush = jest.fn(),
  mockReplace = jest.fn()
let mockParams = new URLSearchParams(),
  mockPathname = '/knowledge'
let mockUser = { id: 1 },
  mockScope = 'backend:session-1'
const mockT = (key: string, options?: { count?: number }) =>
  options?.count === undefined ? key : `${key}: ${options.count}`
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => mockParams,
  usePathname: () => mockPathname,
}))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
}))
jest.mock('@/features/common/UserContext', () => ({ useUser: () => ({ user: mockUser }) }))
jest.mock('@/apis/client', () => ({
  __esModule: true,
  ApiError: class extends Error {},
  default: { getCacheScope: () => mockScope },
}))
jest.mock('@/apis/knowledge-base', () => ({ knowledgeBaseApi: { getAllGrouped: jest.fn() } }))
jest.mock('@/apis/knowledge', () => ({
  getKnowledgeBase: jest.fn(),
  getKnowledgeBaseRetrievalProfile: jest.fn(async () => ({ health: { status: 'unconfigured' } })),
  getMultimodalDefaultPrompts: jest.fn(async () => ({ enabled: false })),
  createKnowledgeBase: jest.fn(),
  migrateKnowledgeBaseToGroup: jest.fn(),
}))
jest.mock('@/apis/models', () => ({
  modelApis: { getUnifiedModels: jest.fn(async () => ({ data: [] })) },
}))
jest.mock('@/apis/groups', () => ({
  searchGroups: jest.fn(async () => ({ items: [] })),
  listGroups: jest.fn(async () => ({
    items: [
      { name: 'team', my_role: 'Owner' },
      { name: 'company', my_role: 'Owner' },
    ],
  })),
}))
jest.mock('@/apis/user', () => ({
  getToken: () => null,
  userApis: { getDefaultTeams: () => new Promise(() => {}) },
}))
jest.mock('@/features/tasks/service/teamService', () => ({
  teamService: { getTeams: () => new Promise(() => {}) },
}))
jest.mock('@/lib/runtime-config', () => ({
  getRuntimeConfigSync: () => ({ enableCodeWiki: true }),
}))
jest.mock('@/features/knowledge/document/hooks/useAdvancedKnowledgeMode', () => ({
  ...jest.requireActual('@/features/knowledge/document/hooks/useAdvancedKnowledgeMode'),
  useAdvancedKnowledgeMode: () => ({
    showAdvancedKnowledge: true,
    setShowAdvancedKnowledge: jest.fn(),
  }),
}))
jest.mock('@/features/knowledge/code-wiki/CodeWikiReader', () => ({
  CodeWikiReader: ({
    wiki,
    canConfigure,
    onConfigure,
  }: {
    wiki: KnowledgeBase
    canConfigure: boolean
    onConfigure: () => void
  }) => (
    <div data-testid="mock-code-wiki-reader">
      {wiki.name}
      {canConfigure && (
        <button data-testid="open-code-wiki-config" onClick={onConfigure}>
          Configure
        </button>
      )}
    </div>
  ),
}))
jest.mock('@/apis/knowledge-permission', () => ({
  knowledgePermissionApi: {
    batchAddPermission: jest.fn(),
    deletePermission: jest.fn(),
    getMyPermission: jest.fn(async () => ({
      has_access: true,
      role: 'Owner',
      is_creator: true,
      pending_request: null,
    })),
    getMyPermissionSources: jest.fn(async () => ({
      has_access: true,
      effective_role: 'Owner',
      is_creator: true,
      sources: [],
    })),
    listPermissions: jest.fn(async () => ({
      pending: [],
      approved: { Owner: [], Maintainer: [], Developer: [], Reporter: [], RestrictedAnalyst: [] },
    })),
  },
}))
jest.mock('@/features/knowledge/document/components/EditKnowledgeBaseDialog', () => ({
  EditKnowledgeBaseDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="mock-edit-knowledge-base-dialog" /> : null,
}))
jest.mock('@/apis/code-wiki', () => ({
  codeWikiApi: { create: jest.fn(), configureScheduledUpdate: jest.fn() },
}))

const baseKb: KnowledgeBase = {
  id: 7,
  name: 'Docs',
  description: null,
  user_id: 1,
  namespace: 'default',
  document_count: 0,
  is_active: true,
  summary_enabled: false,
  kb_type: 'classic',
  max_calls_per_conversation: 10,
  exempt_calls_before_check: 5,
  created_at: '2026-11-04T00:00:00Z',
  updated_at: '2026-11-04T00:00:00Z',
}
function row(kb = baseKb, level = 'personal'): KnowledgeBaseWithGroupInfo {
  return {
    ...kb,
    kb_type: kb.kb_type ?? 'notebook',
    group_id: kb.namespace,
    group_name: 'Destination',
    group_type:
      level === 'organization' ? 'organization' : level === 'group' ? 'group' : 'personal',
    my_role: 'Owner',
  }
}
let data: AllGroupedKnowledgeResponse
beforeEach(() => {
  localStorage.clear()
  jest.clearAllMocks()
  mockParams = new URLSearchParams()
  mockPathname = '/knowledge'
  mockUser = { id: 1 }
  mockScope = 'backend:session-1'
  data = {
    personal: { created_by_me: [row()], shared_with_me: [] },
    groups: [],
    organization: {
      namespace: 'company',
      display_name: 'Company',
      kb_count: 0,
      knowledge_bases: [],
    },
    summary: { total_count: 1, personal_count: 1, group_count: 0, organization_count: 0 },
  }
  jest
    .mocked(knowledgeBaseApi.getAllGrouped)
    .mockImplementation(async () => JSON.parse(JSON.stringify(data)))
  jest.mocked(getKnowledgeBase).mockResolvedValue(baseKb)
  jest.mocked(createKnowledgeBase).mockResolvedValue(baseKb)
  jest.mocked(codeWikiApi.create).mockResolvedValue({ id: 9, name: 'Repository' } as never)
})

jest.mock('@/contexts/TeamContext', () => ({
  useTeamContext: () => ({ teams: [], refreshTeams: jest.fn() }),
}))
jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({ selectTask: jest.fn() }),
}))
jest.mock('@/features/tasks/components/chat', () => ({ ChatArea: () => null }))
jest.mock('@/features/knowledge/document/components/DocumentList', () => ({
  DocumentList: ({ headerActions }: { headerActions?: React.ReactNode }) => (
    <div>{headerActions}</div>
  ),
}))
jest.mock('@/features/knowledge/document/components/KnowledgeSourcePanel', () => ({
  KnowledgeSourcePanel: () => null,
}))
jest.mock('@/features/knowledge/artifact/components/ArtifactWorkspacePanel', () => ({
  ArtifactWorkspacePanel: () => null,
}))
jest.mock('@/features/knowledge/artifact/components/ArtifactSourceDialog', () => ({
  ArtifactSourceDialog: () => null,
}))

it.each([KnowledgeDocumentPageDesktop, KnowledgeDocumentPageMobile])(
  'adds collaborators from real document management (%p)',
  async Page => {
    const { registerAuthSection } =
      await import('@/features/knowledge/document/auth-section-registry')
    registerAuthSection({
      type: 'test-document-target',
      labelKey: 'Test target',
      renderSearch: ({ role, onSelect }) => (
        <button
          onClick={() =>
            onSelect({
              id: '7',
              entityType: 'test-document-target',
              entityId: '7',
              label: 'Document target',
              role,
            })
          }
        >
          Select target
        </button>
      ),
    })
    mockPathname = '/knowledge/default/Docs'
    jest.mocked(knowledgePermissionApi.batchAddPermission).mockResolvedValueOnce({
      succeeded: [{ entity_type: 'test-document-target', entity_id: '7', role: 'Reporter' }],
      failed: [],
    } as never)
    render(<Page initialKbNamespace="default" initialKbName="Docs" />)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('knowledge-detail-permissions-tab'))
    await user.click(await screen.findByTestId('permission-add-collaborator'))
    await user.click(screen.getByRole('button', { name: 'Select target' }))
    const reads = jest.mocked(knowledgeBaseApi.getAllGrouped).mock.calls.length
    await user.click(screen.getByTestId('submit-created-permissions'))
    await waitFor(() => expect(knowledgeBaseApi.getAllGrouped).toHaveBeenCalledTimes(reads + 1))
    expect(knowledgePermissionApi.batchAddPermission).toHaveBeenCalledWith(7, {
      members: [expect.objectContaining({ entity_type: 'test-document-target', entity_id: '7' })],
    })
  }
)

it('keeps approvals independent of member filtering and displays registered members', async () => {
  const { registerPermissionTab } =
    await import('@/features/knowledge/permission/permission-tab-registry')
  registerPermissionTab({
    type: 'test-display',
    labelKey: 'Test department',
    filter: member => member.entity_type === 'test-display',
  })
  jest.mocked(knowledgePermissionApi.listPermissions).mockResolvedValue({
    pending: [{ id: 55, user_id: 8, username: 'Pending user', role: 'Reporter' }],
    approved: {
      Owner: [],
      Maintainer: [],
      Developer: [],
      RestrictedAnalyst: [],
      Reporter: [
        {
          id: 91,
          user_id: 0,
          entity_type: 'test-display',
          entity_id: '7',
          display_name: 'Department A',
          email: '',
          role: 'Reporter',
        },
      ],
    },
  } as never)
  mockPathname = '/knowledge/default/Docs'
  render(<KnowledgeDocumentPageMobile initialKbNamespace="default" initialKbName="Docs" />)
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('knowledge-detail-permissions-tab'))
  await user.type(await screen.findByTestId('knowledge-member-search'), 'absent')
  expect(screen.getByText('Pending user')).toBeInTheDocument()
  expect(screen.getByTestId('permission-approve-55')).toBeEnabled()
  expect(screen.getByTestId('permission-reject-55')).toBeEnabled()
  expect(screen.queryByText('Department A')).not.toBeInTheDocument()
  expect(screen.getByText('document.permission.noMatchingMembers')).toBeInTheDocument()
  await user.clear(screen.getByTestId('knowledge-member-search'))
  expect(screen.getByText('Department A')).toBeInTheDocument()
  expect(screen.getByTestId('knowledge-member-count')).toHaveTextContent('1')
  expect(screen.getByTestId('permission-role-91')).toBeEnabled()
})

it.each(['document', 'created'])(
  'keeps only failed collaborators after a partial grant (%s)',
  async entry => {
    const { registerAuthSection } =
      await import('@/features/knowledge/document/auth-section-registry')
    for (const type of ['test-success', 'test-failure'])
      registerAuthSection({
        type,
        labelKey: type,
        renderSearch: ({ role, onSelect }) => (
          <button
            onClick={() =>
              onSelect({ id: '7', entityType: type, entityId: '7', label: type, role })
            }
          >
            Select {type}
          </button>
        ),
      })
    if (entry === 'document') mockPathname = '/knowledge/default/Docs'
    jest
      .mocked(knowledgePermissionApi.batchAddPermission)
      .mockResolvedValueOnce({
        succeeded: [{ entity_type: 'test-success', entity_id: '7', role: 'Reporter' }],
        failed: [{ entity_type: 'test-failure', entity_id: '7', error: 'Retry this target' }],
      } as never)
      .mockResolvedValueOnce({
        succeeded: [{ entity_type: 'test-failure', entity_id: '7', role: 'Reporter' }],
        failed: [],
      } as never)
    render(
      entry === 'document' ? (
        <KnowledgeDocumentPageMobile initialKbNamespace="default" initialKbName="Docs" />
      ) : (
        <KnowledgeDocumentPageMobile />
      )
    )
    const user = userEvent.setup()
    if (entry === 'document') {
      await user.click(await screen.findByTestId('knowledge-detail-permissions-tab'))
    } else {
      await user.click(await screen.findByTestId('create-kb-button'))
      await user.type(screen.getByTestId('kb-name-input'), 'New library')
      await user.click(document.getElementById('knowledge-summary-enabled')!)
      await user.click(screen.getByTestId('submit-create-kb'))
    }
    await user.click(await screen.findByTestId('permission-add-collaborator'))
    await user.click(screen.getByRole('button', { name: 'Select test-success' }))
    await user.click(screen.getByRole('button', { name: 'Select test-failure' }))
    const reads = jest.mocked(knowledgeBaseApi.getAllGrouped).mock.calls.length
    await user.click(screen.getByTestId('submit-created-permissions'))
    await screen.findByText(/Retry this target/)
    expect(screen.queryByTestId('remove-auth-test-success-7')).not.toBeInTheDocument()
    expect(screen.getByTestId('remove-auth-test-failure-7')).toBeInTheDocument()
    await waitFor(() => expect(knowledgeBaseApi.getAllGrouped).toHaveBeenCalledTimes(reads + 1))
    await user.click(screen.getByTestId('submit-created-permissions'))
    await screen.findByTestId('knowledge-authorization-complete')
    expect(knowledgePermissionApi.batchAddPermission).toHaveBeenLastCalledWith(7, {
      members: [expect.objectContaining({ entity_type: 'test-failure', entity_id: '7' })],
    })
    await waitFor(() => expect(knowledgeBaseApi.getAllGrouped).toHaveBeenCalledTimes(reads + 2))
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('close-add-collaborator')).not.toBeInTheDocument()
    expect(screen.getByTestId('permission-add-collaborator')).toHaveFocus()
  }
)

it('recovers a failed team search and prevents selecting an existing team binding', async () => {
  const { searchGroups } = await import('@/apis/groups')
  jest.mocked(searchGroups).mockRejectedValue(new Error('Search offline'))
  mockPathname = '/knowledge/default/Docs'
  jest.mocked(knowledgePermissionApi.listPermissions).mockResolvedValueOnce({
    pending: [],
    approved: {
      Owner: [],
      Maintainer: [],
      Developer: [],
      RestrictedAnalyst: [],
      Reporter: [
        {
          id: 91,
          user_id: 0,
          entity_type: 'namespace',
          entity_id: '7',
          display_name: 'Bound team',
          email: '',
          role: 'Reporter',
        },
      ],
    },
  } as never)
  render(<KnowledgeDocumentPageMobile initialKbNamespace="default" initialKbName="Docs" />)
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('knowledge-detail-permissions-tab'))
  await user.click(await screen.findByTestId('permission-add-collaborator'))
  await user.click(screen.getByTestId('add-namespace-group-search'))
  await screen.findByText('document.permission.groupSearchFailed')
  expect(screen.queryByText('暂无可用群组')).not.toBeInTheDocument()
  jest.mocked(searchGroups).mockResolvedValue({
    items: [
      { id: 7, name: 'bound', display_name: 'Bound team' },
      { id: 8, name: 'default', display_name: 'Owning space' },
      { id: 9, name: 'available', display_name: 'Available team' },
    ],
  } as never)
  await user.click(screen.getByTestId('retry-auth-group-search'))
  expect(await screen.findByTestId('auth-select-namespace-7')).toBeDisabled()
  expect(screen.getByTestId('auth-select-namespace-8')).toBeDisabled()
  expect(screen.getByTestId('auth-select-namespace-9')).toBeEnabled()
})

it.each([KnowledgeDocumentPageDesktop, KnowledgeDocumentPageMobile])(
  'creates once and opens the shared collaborator flow after a failed list refresh (%p)',
  async Page => {
    const user = userEvent.setup()
    render(<Page />)
    await user.click(await screen.findByTestId('create-kb-button'))
    await user.type(screen.getByTestId('kb-name-input'), 'New library')
    await user.click(document.getElementById('knowledge-summary-enabled')!)
    const created = { ...baseKb, id: 29, name: 'New library' }
    jest.mocked(createKnowledgeBase).mockResolvedValueOnce(created)
    jest.mocked(knowledgeBaseApi.getAllGrouped).mockRejectedValueOnce(new Error('offline'))
    await user.click(screen.getByTestId('submit-create-kb'))
    await screen.findByTestId('retry-created-list')
    expect(screen.getAllByRole('heading', { name: 'document.creation.created' })).toHaveLength(1)
    await screen.findByTestId('knowledge-member-search')
    expect(screen.queryByTestId('created-knowledge-authorization')).not.toBeInTheDocument()
    expect(screen.queryByTestId('submit-created-permissions')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('permission-add-collaborator'))
    expect(screen.getAllByTestId('created-knowledge-authorization')).toHaveLength(1)
    await user.keyboard('{Escape}')
    expect(screen.getByTestId('permission-add-collaborator')).toHaveFocus()
    data.personal.created_by_me.push(row(created))
    await user.click(screen.getByTestId('retry-created-list'))
    await waitFor(() => expect(screen.queryByTestId('retry-created-list')).not.toBeInTheDocument())
    expect(screen.getByTestId('permission-add-collaborator')).toBeEnabled()
    await user.click(screen.getByTestId('finish-created-authorization'))
    await waitFor(() => expect(screen.getByTestId('create-kb-button')).toHaveFocus())
    expect(screen.getByTestId('kb-row-29')).toBeInTheDocument()
    expect(createKnowledgeBase).toHaveBeenCalledTimes(1)
    expect(knowledgePermissionApi.batchAddPermission).not.toHaveBeenCalled()
  }
)
