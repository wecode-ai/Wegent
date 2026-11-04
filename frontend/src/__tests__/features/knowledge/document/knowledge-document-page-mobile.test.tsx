// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  }: {
    selectedKb: KnowledgeBase
    initialDocPath?: string
  }) => (
    <div data-testid="mock-detail-panel">
      {selectedKb.name}
      <span>{initialDocPath}</span>
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
jest.mock('@/features/knowledge/permission/hooks/useKnowledgePermissions', () => ({
  useKnowledgePermissions: () => ({
    myPermission: { has_access: true, role: 'Owner', is_creator: true },
    fetchMyPermission: mockFetchMyPermission,
  }),
}))
const mockFetchMyPermission = jest.fn()
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
  jest.mocked(knowledgeBaseApi.getAllGrouped).mockImplementation(async () => data)
  jest.mocked(getKnowledgeBase).mockResolvedValue(baseKb)
  jest.mocked(createKnowledgeBase).mockResolvedValue(baseKb)
  jest.mocked(codeWikiApi.create).mockResolvedValue({ id: 9, name: 'Repository' } as never)
})

it('renders the shared relationship list as readable mobile rows and keeps migration', async () => {
  render(<KnowledgeDocumentPageMobile />)
  expect(await screen.findByTestId('knowledge-mobile-list')).toBeInTheDocument()
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(screen.getByTestId('kb-row-7')).toHaveTextContent('Personal space')
  expect(screen.getByTestId('migrate-kb-7')).toBeInTheDocument()
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
  await userEvent.setup().click(screen.getByTestId('open-code-wiki-config'))
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
