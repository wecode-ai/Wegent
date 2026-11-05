// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KnowledgeDocumentPageDesktop } from '@/features/knowledge/document/components/KnowledgeDocumentPageDesktop'
import { KnowledgeDocumentPageMobile } from '@/features/knowledge/document/components/KnowledgeDocumentPageMobile'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { createKnowledgeBase, getKnowledgeBase } from '@/apis/knowledge'
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
const mockT = (key: string) => key
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
  createKnowledgeBase: jest.fn(),
  migrateKnowledgeBaseToGroup: jest.fn(),
}))
jest.mock('@/apis/groups', () => ({
  listGroups: jest.fn(async () => ({
    items: [
      { name: 'team', my_role: 'Owner' },
      { name: 'company', my_role: 'Owner' },
    ],
  })),
}))
jest.mock('@/apis/user', () => ({ userApis: { getDefaultTeams: () => new Promise(() => {}) } }))
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
jest.mock('@/features/knowledge/document/components/KnowledgeDetailPanel', () => ({
  KnowledgeDetailPanel: ({
    selectedKb,
    initialDocPath,
    onPermissionsChanged,
  }: {
    selectedKb: KnowledgeBase
    initialDocPath?: string
    onPermissionsChanged?: () => void
  }) => (
    <div data-testid="mock-detail-panel">
      {selectedKb.name}
      <span>{initialDocPath}</span>
      <button data-testid="refresh-detail-permissions" onClick={onPermissionsChanged}>
        Refresh
      </button>
    </div>
  ),
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
jest.mock('@/features/knowledge/document/components/CreateKnowledgeBaseDialog', () => ({
  CreateKnowledgeBaseDialog: ({
    open,
    onSubmit,
  }: {
    open: boolean
    onSubmit: (data: unknown) => Promise<void>
  }) =>
    open ? (
      <div data-testid="create-kb-dialog">
        <button
          data-testid="submit-normal-kb"
          onClick={() =>
            void onSubmit({ name: 'Docs', kb_type: 'notebook', allow_document_download: false })
          }
        >
          Create document
        </button>
        <button
          data-testid="submit-code-wiki"
          onClick={() =>
            void onSubmit({
              name: 'Repository',
              kb_type: 'code_wiki',
              source_type: 'github',
              source_url: 'https://github.com/wecode-ai/Wegent.git',
              execution_model_ref: { name: 'model-a', namespace: 'default', type: 'public' },
            })
          }
        >
          Create code
        </button>
      </div>
    ) : null,
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
    namespace_level: level,
    namespace_display_name:
      level === 'personal'
        ? 'Personal space'
        : level === 'group'
          ? 'Real team space'
          : 'Real company space',
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

it('renders the shared relationship list as readable mobile rows and keeps migration', async () => {
  render(<KnowledgeDocumentPageMobile />)
  expect(await screen.findByTestId('knowledge-mobile-list')).toBeInTheDocument()
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(screen.getByTestId('kb-row-7')).toHaveTextContent('Personal space')
  expect(screen.queryByTestId('migrate-kb-7')).not.toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(screen.getByTestId('more-kb-7'))
  expect(screen.getByTestId('migrate-kb-7')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  await userEvent.setup().click(screen.getByTestId('knowledge-mobile-navigation-toggle'))
  expect(screen.getByTestId('nav-personal-item')).toBeInTheDocument()
  expect(knowledgeBaseApi.getAllGrouped).toHaveBeenCalledTimes(1)
})

it('opens a personal deep link and returns to the list using the existing route', async () => {
  mockPathname = '/knowledge/default/Docs'
  render(
    <KnowledgeDocumentPageMobile
      initialKbNamespace="default"
      initialKbName="Docs"
      initialDocPath="folder/readme.md"
    />
  )
  expect(await screen.findByTestId('mock-detail-panel')).toHaveTextContent('folder/readme.md')
  await userEvent.setup().click(screen.getByTestId('knowledge-detail-back-button'))
  expect(mockPush).toHaveBeenCalledWith('/knowledge?type=document')
})

it.each(['group', 'organization'])(
  'resolves %s deep links without expanded mobile tree state',
  async level => {
    const kb = { ...baseKb, namespace: level === 'group' ? 'team' : 'company' }
    if (level === 'group')
      data.groups = [
        {
          group_name: 'team',
          group_display_name: 'Team',
          kb_count: 1,
          knowledge_bases: [row(kb, level)],
        },
      ]
    else data.organization.knowledge_bases = [row(kb, level)]
    data.personal.created_by_me = []
    mockPathname = `/knowledge/${kb.namespace}/Docs`
    jest.mocked(getKnowledgeBase).mockResolvedValue(kb)
    render(<KnowledgeDocumentPageMobile initialKbNamespace={kb.namespace} initialKbName="Docs" />)
    expect(await screen.findByTestId('mock-detail-panel')).toHaveTextContent('Docs')
  }
)

it('keeps the code reader and existing configuration dialog', async () => {
  const kb = { ...baseKb, kb_type: 'code_wiki' as const }
  data.personal.created_by_me = [row(kb)]
  jest.mocked(getKnowledgeBase).mockResolvedValue(kb)
  mockPathname = '/knowledge/default/Docs'
  render(<KnowledgeDocumentPageMobile initialKbNamespace="default" initialKbName="Docs" />)
  expect(await screen.findByTestId('mock-code-wiki-reader')).toHaveTextContent('Docs')
  await userEvent.setup().click(await screen.findByTestId('open-code-wiki-config'))
  expect(screen.getByTestId('mock-edit-knowledge-base-dialog')).toBeInTheDocument()
})

it('retains document creation settings and the dedicated code creation endpoint', async () => {
  render(<KnowledgeDocumentPageMobile />)
  await userEvent.setup().click(await screen.findByTestId('create-kb-button'))
  await userEvent.setup().click(screen.getByTestId('submit-normal-kb'))
  await waitFor(() =>
    expect(createKnowledgeBase).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'default', allow_document_download: false })
    )
  )
  await waitFor(() => expect(screen.queryByTestId('create-kb-dialog')).not.toBeInTheDocument())
  await userEvent.setup().click(await screen.findByTestId('finish-created-authorization'))
  await userEvent.setup().click(screen.getByTestId('create-kb-button'))
  await userEvent.setup().click(screen.getByTestId('submit-code-wiki'))
  await waitFor(() =>
    expect(codeWikiApi.create).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'default',
        source_url: 'https://github.com/wecode-ai/Wegent.git',
      })
    )
  )
  expect(mockPush).not.toHaveBeenCalled()
})

it('keeps the public company link distinct from a personal library with the same name', async () => {
  const company = { ...baseKb, id: 8, namespace: 'company' }
  data.organization.knowledge_bases = [row(company, 'organization')]
  mockPathname = '/knowledge/public/Docs'
  jest.mocked(getKnowledgeBase).mockResolvedValue(company)
  render(<KnowledgeDocumentPageMobile initialKbName="Docs" />)
  await screen.findByTestId('mock-detail-panel')
  expect(getKnowledgeBase).toHaveBeenCalledWith(8)
  expect(getKnowledgeBase).not.toHaveBeenCalledWith(7)
})

it('retains the created authorization session while the pre-creation list is all that is available', async () => {
  let finish!: (value: AllGroupedKnowledgeResponse) => void
  render(<KnowledgeDocumentPageMobile />)
  await screen.findByTestId('create-kb-button')
  jest.mocked(createKnowledgeBase).mockResolvedValueOnce({ ...baseKb, id: 29, name: 'New library' })
  jest.mocked(knowledgeBaseApi.getAllGrouped).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  await userEvent.setup().click(screen.getByTestId('create-kb-button'))
  await userEvent.setup().click(screen.getByTestId('submit-normal-kb'))
  expect(await screen.findByTestId('created-knowledge-authorization')).toBeInTheDocument()
  expect(screen.queryByTestId('kb-row-29')).not.toBeInTheDocument()
  await act(async () => finish(data))
  await waitFor(() =>
    expect(screen.queryByTestId('created-knowledge-authorization')).not.toBeInTheDocument()
  )
  expect(createKnowledgeBase).toHaveBeenCalledTimes(1)
})

it('retries a failed list refresh for the already-created library without creating it again', async () => {
  render(<KnowledgeDocumentPageMobile />)
  await screen.findByTestId('create-kb-button')
  const created = { ...baseKb, id: 29, name: 'New library' }
  jest.mocked(createKnowledgeBase).mockResolvedValueOnce(created)
  jest.mocked(knowledgeBaseApi.getAllGrouped).mockRejectedValueOnce(new Error('offline'))
  await userEvent.setup().click(screen.getByTestId('create-kb-button'))
  await userEvent.setup().click(screen.getByTestId('submit-normal-kb'))
  expect(await screen.findByTestId('retry-created-list')).toBeInTheDocument()
  data.personal.created_by_me.push(row(created))
  await userEvent.setup().click(screen.getByTestId('retry-created-list'))
  await waitFor(() => expect(screen.queryByTestId('retry-created-list')).not.toBeInTheDocument())
  expect(screen.getByTestId('created-knowledge-authorization')).toBeInTheDocument()
  expect(createKnowledgeBase).toHaveBeenCalledTimes(1)
})

it('returns focus to the create action when authorization is skipped', async () => {
  render(<KnowledgeDocumentPageMobile />)
  const trigger = await screen.findByTestId('create-kb-button')
  await userEvent.setup().click(trigger)
  await userEvent.setup().click(screen.getByTestId('submit-normal-kb'))
  await userEvent.setup().click(await screen.findByTestId('finish-created-authorization'))
  await waitFor(() => expect(trigger).toHaveFocus())
})

it('keeps team filtering within each relationship and clears it when opening company knowledge', async () => {
  const owned = row({ ...baseKb, id: 31, name: 'Owned team library', namespace: 'team' }, 'group')
  const shared = row(
    { ...baseKb, id: 32, name: 'Shared team library', namespace: 'team', user_id: 2 },
    'group'
  )
  const personal = row({ ...baseKb, id: 33, name: 'Personal shared library', user_id: 2 })
  const company = row(
    { ...baseKb, id: 34, name: 'Company guide', namespace: 'company', user_id: 2 },
    'organization'
  )
  data.groups = [
    {
      group_name: 'team',
      group_display_name: 'Team',
      kb_count: 2,
      knowledge_bases: [owned, shared, personal, data.personal.created_by_me[0]],
    },
  ]
  data.personal.shared_with_me = [personal]
  data.organization.knowledge_bases = [company]
  render(<KnowledgeDocumentPageMobile />)
  await screen.findByTestId('kb-row-31')
  const user = userEvent.setup()
  async function openEntry(id: string) {
    await user.click(screen.getByTestId('knowledge-mobile-navigation-toggle'))
    await user.click(screen.getByTestId(id))
  }
  await openEntry('nav-personal-item')
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.getByTestId('knowledge-team-count-group-team')).toHaveTextContent('1')
  await user.click(screen.getByTestId('knowledge-team-option-group-team'))
  expect(screen.getByTestId('kb-row-31')).toBeInTheDocument()
  expect(screen.queryByTestId('kb-row-32')).not.toBeInTheDocument()
  expect(screen.queryByTestId('kb-row-7')).not.toBeInTheDocument()
  await openEntry('nav-shared-item')
  expect(screen.getByTestId('knowledge-team-filter')).toHaveTextContent(
    'document.navigation.filters'
  )
  expect(screen.getByTestId('kb-row-33')).toBeInTheDocument()
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.getByTestId('knowledge-team-count-group-team')).toHaveTextContent('1')
  await user.click(screen.getByTestId('knowledge-team-option-group-team'))
  expect(screen.getByTestId('kb-row-32')).toBeInTheDocument()
  expect(screen.queryByTestId('kb-row-31')).not.toBeInTheDocument()
  expect(screen.queryByTestId('kb-row-33')).not.toBeInTheDocument()
  await openEntry('nav-organization-item')
  expect(screen.queryByTestId('knowledge-team-filter')).not.toBeInTheDocument()
  expect(screen.getByTestId('kb-row-34')).toBeInTheDocument()
  expect(screen.getByTestId('knowledge-search')).toBeInTheDocument()
  await user.click(screen.getByTestId('knowledge-mobile-filters'))
  expect(screen.getByTestId('knowledge-sort')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  await openEntry('nav-personal-item')
  expect(screen.getByTestId('knowledge-team-filter')).toHaveTextContent(
    'document.navigation.filters'
  )
  expect(screen.getByTestId('kb-row-7')).toBeInTheDocument()
  expect(screen.getByTestId('kb-row-31')).toBeInTheDocument()
})

it('keeps company libraries only in all and company entries and filters the deduplicated company scope', async () => {
  const ownedCompany = row(
    { ...baseKb, id: 41, name: 'Owned company', namespace: 'company' },
    'organization'
  )
  const sharedCompany = row(
    { ...baseKb, id: 42, name: 'Shared company', namespace: 'company', user_id: 2 },
    'organization'
  )
  const personal = row({ ...baseKb, id: 43, name: 'Shared personal', user_id: 2 })
  data.personal.created_by_me.push(ownedCompany)
  data.personal.shared_with_me = [sharedCompany, personal]
  data.organization.knowledge_bases = [ownedCompany, sharedCompany]
  render(<KnowledgeDocumentPageMobile />)
  await screen.findByTestId('kb-row-41')
  const user = userEvent.setup()
  async function openEntry(id: string) {
    await user.click(screen.getByTestId('knowledge-mobile-navigation-toggle'))
    await user.click(screen.getByTestId(id))
  }
  expect(screen.getByTestId('knowledge-result-count')).toHaveTextContent('4')
  expect(screen.getAllByTestId('kb-row-41')).toHaveLength(1)
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.getByTestId('knowledge-space-count-company')).toHaveTextContent('2')
  await user.type(screen.getByTestId('knowledge-team-search'), 'companySpace')
  await user.click(screen.getByTestId('knowledge-space-option-company'))
  expect(screen.getByTestId('knowledge-result-count')).toHaveTextContent('2')
  expect(screen.queryByTestId('kb-row-7')).not.toBeInTheDocument()
  await user.type(screen.getByTestId('knowledge-search'), 'Owned')
  expect(screen.getByTestId('knowledge-result-count')).toHaveTextContent('1')
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.getByTestId('knowledge-space-count-company')).toHaveTextContent('1')
  await user.keyboard('{Escape}')
  await user.clear(screen.getByTestId('knowledge-search'))
  await openEntry('nav-personal-item')
  expect(screen.getByTestId('kb-row-7')).toBeInTheDocument()
  expect(screen.queryByTestId('kb-row-41')).not.toBeInTheDocument()
  expect(screen.queryByTestId('kb-row-42')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.queryByTestId('knowledge-space-option-company')).not.toBeInTheDocument()
  await user.keyboard('{Escape}')
  await openEntry('nav-shared-item')
  expect(screen.getByTestId('kb-row-43')).toBeInTheDocument()
  expect(screen.queryByTestId('kb-row-42')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.queryByTestId('knowledge-space-option-company')).not.toBeInTheDocument()
  await user.keyboard('{Escape}')
  await openEntry('nav-organization-item')
  expect(screen.getByTestId('kb-row-41')).toBeInTheDocument()
  expect(screen.getByTestId('kb-row-42')).toBeInTheDocument()
  expect(screen.getByTestId('knowledge-result-count')).toHaveTextContent('2')
  expect(screen.queryByTestId('knowledge-team-filter')).not.toBeInTheDocument()
  await openEntry('nav-all-item')
  await user.click(screen.getByTestId('knowledge-team-filter'))
  await user.click(screen.getByTestId('knowledge-space-option-company'))
  await user.click(screen.getByTestId('create-kb-button'))
  expect(screen.getByTestId('create-kb-dialog')).toBeInTheDocument()
})

it.each([false, true])(
  'resolves renamed same-name links by ID in the shared workspace (mobile=%s)',
  async mobile => {
    const renamed = { ...baseKb, id: 81, name: 'Renamed library', user_id: 2 }
    data.personal.shared_with_me = [row(renamed)]
    mockPathname = '/knowledge/default/Old%20name/folder/readme.md'
    mockParams = new URLSearchParams({ kb: '81', taskId: 'task-one' })
    jest.mocked(getKnowledgeBase).mockResolvedValue(renamed)
    const replace = jest.spyOn(window.history, 'replaceState')
    const Component = mobile ? KnowledgeDocumentPageMobile : KnowledgeDocumentPageDesktop
    render(<Component initialKbNamespace="default" initialKbName="Old name" />)
    expect(await screen.findByTestId('mock-detail-panel')).toHaveTextContent('Renamed library')
    expect(getKnowledgeBase).toHaveBeenCalledWith(81)
    expect(getKnowledgeBase).not.toHaveBeenCalledWith(7)
    expect(replace).toHaveBeenCalledWith(
      {},
      '',
      '/knowledge/default/Renamed%20library/folder/readme.md?kb=81&taskId=task-one'
    )
    replace.mockRestore()
  }
)

it.each([false, true])(
  'reports an ambiguous link instead of choosing the first library (mobile=%s)',
  async mobile => {
    data.personal.shared_with_me = [row({ ...baseKb, id: 82, user_id: 2 })]
    mockPathname = '/knowledge/default/Docs'
    const Component = mobile ? KnowledgeDocumentPageMobile : KnowledgeDocumentPageDesktop
    render(<Component initialKbNamespace="default" initialKbName="Docs" />)
    expect(await screen.findByTestId('knowledge-url-ambiguous')).toBeInTheDocument()
    expect(screen.queryByTestId('mock-detail-panel')).not.toBeInTheDocument()
    expect(getKnowledgeBase).not.toHaveBeenCalled()
  }
)

it('retries a failed initial link lookup and recovers the requested detail', async () => {
  mockPathname = '/knowledge/default/Docs'
  mockParams = new URLSearchParams({ kb: '7' })
  jest.mocked(knowledgeBaseApi.getAllGrouped).mockRejectedValueOnce(new Error('offline'))
  render(<KnowledgeDocumentPageMobile initialKbNamespace="default" initialKbName="Docs" />)
  expect(await screen.findByTestId('knowledge-url-error')).toBeInTheDocument()
  await userEvent.setup().click(screen.getByTestId('knowledge-url-retry'))
  expect(await screen.findByTestId('mock-detail-panel')).toHaveTextContent('Docs')
})

it('retains the mounted detail through a same-scope refresh failure and retries', async () => {
  mockPathname = '/knowledge/default/Docs'
  mockParams = new URLSearchParams({ kb: '7' })
  render(<KnowledgeDocumentPageMobile initialKbNamespace="default" initialKbName="Docs" />)
  const detail = await screen.findByTestId('mock-detail-panel')
  const calls = jest.mocked(getKnowledgeBase).mock.calls.length
  let reject!: (reason: Error) => void
  jest.mocked(knowledgeBaseApi.getAllGrouped).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail
      })
  )
  await userEvent.setup().click(screen.getByTestId('refresh-detail-permissions'))
  expect(screen.getByTestId('mock-detail-panel')).toBe(detail)
  await act(async () => reject(new Error('offline')))
  expect(await screen.findByTestId('knowledge-url-error')).toBeInTheDocument()
  expect(screen.getByTestId('mock-detail-panel')).toBe(detail)
  await userEvent.setup().click(screen.getByTestId('knowledge-url-retry'))
  await waitFor(() => expect(screen.queryByTestId('knowledge-url-error')).not.toBeInTheDocument())
  expect(screen.getByTestId('mock-detail-panel')).toBe(detail)
  expect(getKnowledgeBase).toHaveBeenCalledTimes(calls)
})

it.each([500, 403, 404])(
  'terminates failed detail loading and retries the selected ID (%s)',
  async status => {
    mockPathname = '/knowledge/default/Docs'
    mockParams = new URLSearchParams({ kb: '7' })
    const { ApiError } = jest.requireMock('@/apis/client')
    const error = Object.assign(new ApiError('detail unavailable'), { status })
    jest.mocked(getKnowledgeBase).mockRejectedValueOnce(error)
    const log = jest.spyOn(console, 'error').mockImplementation(() => {})
    render(<KnowledgeDocumentPageMobile initialKbNamespace="default" initialKbName="Docs" />)
    expect(await screen.findByTestId('knowledge-url-error')).toBeInTheDocument()
    expect(screen.queryByTestId('mock-detail-panel')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByTestId('knowledge-url-retry'))
    expect(await screen.findByTestId('mock-detail-panel')).toHaveTextContent('Docs')
    expect(getKnowledgeBase).toHaveBeenLastCalledWith(7)
    log.mockRestore()
  }
)
