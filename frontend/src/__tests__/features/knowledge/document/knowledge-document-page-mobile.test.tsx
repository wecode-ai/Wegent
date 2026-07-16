// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { KnowledgeDocumentPageMobile } from '@/features/knowledge/document/components/KnowledgeDocumentPageMobile'
import type { KnowledgeBase } from '@/types/knowledge'

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
  }: {
    onSelectKb: (kb: Pick<KnowledgeBase, 'id' | 'name' | 'namespace'>) => void
  }) => (
    <div data-testid="mock-knowledge-tree">
      <button
        type="button"
        data-testid="select-first-kb"
        onClick={() => onSelectKb({ id: 999, name: 'TestKB', namespace: 'default' })}
      >
        Select KB
      </button>
    </div>
  ),
}))

jest.mock('@/features/knowledge/document/components/CreateKnowledgeBaseDialog', () => ({
  CreateKnowledgeBaseDialog: () => null,
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

jest.mock('@/apis/user', () => ({
  userApis: {
    getDefaultTeams: jest
      .fn()
      .mockResolvedValue({ knowledge: { name: 'test', namespace: 'default' } }),
  },
}))

jest.mock('@/features/tasks/service/teamService', () => ({
  teamService: {
    getTeams: jest.fn().mockResolvedValue({ items: [] }),
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
})
