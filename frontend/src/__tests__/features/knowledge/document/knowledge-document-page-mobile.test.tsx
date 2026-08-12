// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { KnowledgeDocumentPageMobile } from '@/features/knowledge/document/components/KnowledgeDocumentPageMobile'
import type { KnowledgeBase } from '@/types/knowledge'
import { codeWikiApi } from '@/apis/code-wiki'

interface MockKnowledgeTree {
  treeNodes: unknown[]
  selectedKb: KnowledgeBase | null
  selectedKbId: number | null
  loading: boolean
  expandState: Record<string, unknown>
  toggleExpand: jest.Mock
  selectKb: jest.Mock
  clearSelection: jest.Mock
  groups: unknown[]
  orgNamespace: string
  groupKbMap: Record<string, unknown>
  groupKbLoading: Record<string, unknown>
  loadGroupKbs: jest.Mock<Promise<void>>
  refreshAll: jest.Mock
  refreshPersonal: jest.Mock
  refreshOrg: jest.Mock
  refreshGroup: jest.Mock
  personalData: unknown
  orgKbs: KnowledgeBase[]
}

interface KNavigationProps {
  push: (url: string) => void
}

const mockPush = jest.fn()

const mockRouter: KNavigationProps = { push: mockPush }

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'document.backToList' ? 'Back to knowledge bases' : key),
    i18n: { language: 'en' },
  }),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: 99 } }),
}))

jest.mock('@/features/knowledge/document/hooks/useNamespaceRoleMap', () => ({
  useNamespaceRoleMap: () => new Map(),
}))

jest.mock('@/features/knowledge/permission/hooks/useKnowledgePermissions', () => ({
  useKnowledgePermissions: () => ({ myPermission: null, fetchMyPermission: jest.fn() }),
}))

const baseKb: KnowledgeBase = {
  id: 1,
  name: 'MyKB',
  description: null,
  user_id: 99,
  namespace: 'default',
  document_count: 0,
  is_active: true,
  summary_enabled: false,
  kb_type: 'notebook',
  max_calls_per_conversation: 10,
  exempt_calls_before_check: 5,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  guided_questions: [],
}

function createMockTree(overrides?: Partial<MockKnowledgeTree>) {
  const mockTree: MockKnowledgeTree = {
    treeNodes: [],
    selectedKb: null,
    selectedKbId: null,
    loading: false,
    expandState: {},
    toggleExpand: jest.fn(),
    selectKb: jest.fn(kb => {
      mockTree.selectedKbId = kb.id
      mockTree.selectedKb = kb
    }),
    clearSelection: jest.fn(),
    groups: [],
    orgNamespace: 'organization',
    groupKbMap: {},
    groupKbLoading: {},
    loadGroupKbs: jest.fn().mockResolvedValue(undefined),
    refreshAll: jest.fn(),
    refreshPersonal: jest.fn(),
    refreshOrg: jest.fn(),
    refreshGroup: jest.fn(),
    personalData: null,
    orgKbs: [],
    ...overrides,
  }

  return mockTree
}

const mockTree = createMockTree()

jest.mock('@/features/knowledge/document/hooks/useKnowledgeTree', () => ({
  useKnowledgeTree: () => mockTree,
}))

jest.mock('@/features/knowledge/document/components/KnowledgeTree', () => ({
  KnowledgeTree: ({
    onSelectKb,
    onCreateKb,
  }: {
    onSelectKb: (kb: Pick<KnowledgeBase, 'id' | 'name' | 'namespace'>) => void
    onCreateKb: (scope: 'personal', kbType: 'code_wiki') => void
  }) => (
    <div data-testid="mock-knowledge-tree">
      <button
        type="button"
        data-testid="select-first-kb"
        onClick={() => onSelectKb({ id: 999, name: 'TestKB', namespace: 'default' })}
      >
        Select KB
      </button>
      <button
        type="button"
        data-testid="create-code-wiki"
        onClick={() => onCreateKb('personal', 'code_wiki')}
      >
        Create Code Wiki
      </button>
    </div>
  ),
}))

jest.mock('@/features/knowledge/document/components/CreateKnowledgeBaseDialog', () => ({
  CreateKnowledgeBaseDialog: ({
    open,
    onSubmit,
  }: {
    open: boolean
    onSubmit: (data: Record<string, unknown>) => Promise<void>
  }) =>
    open ? (
      <button
        type="button"
        data-testid="submit-code-wiki"
        onClick={() =>
          void onSubmit({
            name: '',
            description: undefined,
            kb_type: 'code_wiki',
            source_type: 'github',
            source_url: 'https://github.com/wecode-ai/Wegent.git',
            language: 'zh',
            resolved_name: 'Wegent',
            resolved_description: 'Agent platform',
            execution_model_ref: { name: 'model-a', namespace: 'default', type: 'public' },
          })
        }
      >
        Submit Code Wiki
      </button>
    ) : null,
}))

jest.mock('@/features/knowledge/code-wiki/CodeWikiReader', () => ({
  CodeWikiReader: ({
    wiki,
    canConfigure,
    onConfigure,
  }: {
    wiki: Pick<KnowledgeBase, 'name'>
    canConfigure?: boolean
    onConfigure?: () => void
  }) => (
    <div data-testid="mock-code-wiki-reader">
      {wiki.name}
      {canConfigure && (
        <button type="button" data-testid="open-code-wiki-config" onClick={onConfigure}>
          Configure
        </button>
      )}
    </div>
  ),
}))

jest.mock('@/features/knowledge/document/components/EditKnowledgeBaseDialog', () => ({
  EditKnowledgeBaseDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="mock-edit-knowledge-base-dialog" /> : null,
}))

jest.mock('@/apis/code-wiki', () => ({
  codeWikiApi: { create: jest.fn() },
}))

import { getKnowledgeBase } from '@/apis/knowledge'

jest.mock('@/apis/knowledge', () => {
  const actual = jest.requireActual('@/apis/knowledge')
  const getKnowledgeBase = jest.fn()
  return {
    __esModule: true,
    ...actual,
    getKnowledgeBase,
  }
})

const mockGetKnowledgeBase = jest.mocked(getKnowledgeBase)
const mockCreateCodeWiki = jest.mocked(codeWikiApi.create)

jest.mock('@/apis/user', () => ({
  userApis: {
    getDefaultTeams: jest.fn(() => new Promise(() => {})),
  },
}))

jest.mock('@/features/tasks/service/teamService', () => ({
  teamService: {
    getTeams: jest.fn(() => new Promise(() => {})),
  },
}))

jest.mock('@/features/knowledge/document/components/KnowledgeDetailPanel', () => ({
  KnowledgeDetailPanel: ({
    selectedKb,
    initialDocPath,
  }: {
    selectedKb?: Pick<KnowledgeBase, 'name'>
    initialDocPath?: string
  }) => (
    <div data-testid="mock-detail-panel">
      <span data-testid="detail-kb-name">{selectedKb?.name}</span>
      <span data-testid="detail-doc-path">{initialDocPath}</span>
    </div>
  ),
}))

const defaultTreeState: Partial<MockKnowledgeTree> = {
  treeNodes: [],
  selectedKb: null,
  selectedKbId: null,
  loading: false,
  personalData: null,
  orgKbs: [],
  groupKbMap: {},
  groupKbLoading: {},
  expandState: {},
}

function resetMockTree() {
  Object.assign(mockTree, defaultTreeState)
  mockTree.loadGroupKbs = jest.fn().mockResolvedValue(undefined)
  mockTree.selectKb = jest.fn(kb => {
    mockTree.selectedKbId = kb.id
    mockTree.selectedKb = kb
  })
  mockTree.toggleExpand = jest.fn()
  mockTree.clearSelection = jest.fn()
  mockTree.refreshAll = jest.fn()
  mockTree.refreshPersonal = jest.fn()
  mockTree.refreshOrg = jest.fn()
  mockTree.refreshGroup = jest.fn()
  mockGetKnowledgeBase.mockReset()
  mockGetKnowledgeBase.mockResolvedValue(baseKb)
  mockCreateCodeWiki.mockReset()
  mockCreateCodeWiki.mockResolvedValue({
    id: 8,
    name: 'Wegent',
    project_name: 'wecode-ai/Wegent',
    source_url: 'https://github.com/wecode-ai/Wegent.git',
    last_published_commit: '',
    document_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  })
}

describe('KnowledgeDocumentPageMobile detail view switch', () => {
  beforeEach(() => {
    mockPush.mockReset()
    resetMockTree()
  })

  it('1) no deep-link props → renders tree', () => {
    render(<KnowledgeDocumentPageMobile />)
    expect(screen.getByTestId('mock-knowledge-tree')).toBeInTheDocument()
    expect(screen.queryByTestId('mock-detail-panel')).not.toBeInTheDocument()
  })

  it('2) personal KB deep-link → renders detail', async () => {
    mockTree.personalData = {
      created_by_me: [baseKb],
      shared_with_me: [],
    }

    render(
      <KnowledgeDocumentPageMobile
        initialKbNamespace="default"
        initialKbName="MyKB"
        initialDocPath="path/to/doc.md"
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('mock-detail-panel')).toBeInTheDocument()
    })
    expect(screen.getByTestId('detail-kb-name')).toHaveTextContent('MyKB')
    expect(screen.getByTestId('detail-doc-path')).toHaveTextContent('path/to/doc.md')
  })

  it('3) team KB deep-link triggers loadGroupKbs', async () => {
    const teamNamespace = 'team42'

    render(
      <KnowledgeDocumentPageMobile initialKbNamespace={teamNamespace} initialKbName="TeamKB" />
    )

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-document-page-mobile')).toBeInTheDocument()
    })
    expect(mockTree.loadGroupKbs).toHaveBeenCalledWith(teamNamespace)
  })

  it('4) organization KB deep-link matches by name and renders detail', async () => {
    const orgKb = { ...baseKb, id: 3, name: 'OrgKB', namespace: 'organization' }

    mockTree.orgKbs = [orgKb]
    mockGetKnowledgeBase.mockResolvedValue(orgKb)

    render(<KnowledgeDocumentPageMobile initialKbName="OrgKB" />)

    await waitFor(() => {
      expect(screen.getByTestId('mock-detail-panel')).toBeInTheDocument()
    })
    expect(screen.getByTestId('detail-kb-name')).toHaveTextContent('OrgKB')
  })

  it('5) back button navigates to /knowledge?type=document', async () => {
    mockTree.personalData = {
      created_by_me: [baseKb],
      shared_with_me: [],
    }

    render(<KnowledgeDocumentPageMobile initialKbNamespace="default" initialKbName="MyKB" />)

    const backButton = await screen.findByTestId('knowledge-detail-back-button')
    await userEvent.click(backButton)

    expect(mockPush).toHaveBeenCalledWith('/knowledge?type=document')
  })

  it('6) code wiki deep-link uses the reader and hides the document view switcher', async () => {
    const codeWiki = { ...baseKb, id: 7, name: 'Wegent', kb_type: 'code_wiki' as const }
    const onKnowledgeViewStateChange = jest.fn()
    mockTree.personalData = { created_by_me: [codeWiki], shared_with_me: [] }
    mockGetKnowledgeBase.mockResolvedValue(codeWiki)

    render(
      <KnowledgeDocumentPageMobile
        initialKbNamespace="default"
        initialKbName="Wegent"
        onKnowledgeViewStateChange={onKnowledgeViewStateChange}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('mock-code-wiki-reader')).toHaveTextContent('Wegent')
    })
    expect(screen.queryByTestId('mock-detail-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('knowledge-detail-back-button')).not.toBeInTheDocument()
    expect(onKnowledgeViewStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: false })
    )
  })

  it('7) mobile code wiki creation uses the dedicated coordinator and API', async () => {
    render(<KnowledgeDocumentPageMobile />)

    await userEvent.click(screen.getByTestId('create-code-wiki'))
    await userEvent.click(screen.getByTestId('submit-code-wiki'))

    await waitFor(() => {
      expect(mockCreateCodeWiki).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'default',
          source_type: 'github',
          source_url: 'https://github.com/wecode-ai/Wegent.git',
          execution_model_ref: { name: 'model-a', namespace: 'default', type: 'public' },
        })
      )
    })
    expect(mockPush).toHaveBeenCalledWith('/knowledge/default/Wegent')
  })

  it('8) code wiki owners can reach the existing KB configuration dialog', async () => {
    const codeWiki = { ...baseKb, id: 7, name: 'Wegent', kb_type: 'code_wiki' as const }
    mockTree.personalData = { created_by_me: [codeWiki], shared_with_me: [] }
    mockGetKnowledgeBase.mockResolvedValue(codeWiki)

    render(<KnowledgeDocumentPageMobile initialKbNamespace="default" initialKbName="Wegent" />)

    await userEvent.click(await screen.findByTestId('open-code-wiki-config'))

    expect(screen.getByTestId('mock-edit-knowledge-base-dialog')).toBeInTheDocument()
  })
})
