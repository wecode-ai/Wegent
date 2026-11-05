// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'

import { KnowledgeDocumentPageMobile } from '@/features/knowledge/document/components/KnowledgeDocumentPageMobile'
import type { KnowledgeBase } from '@/types/knowledge'
import { codeWikiApi } from '@/apis/code-wiki'

interface MockKnowledgeTree {
  treeNodes: unknown[]
  selectedKb: KnowledgeBase | null
  selectedKbId: number | null
  loading: boolean
  hasLoadError: boolean
  groupKbErrors: Record<string, boolean>
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

let mockSearchParams = new URLSearchParams()
const mockPush = jest.fn()
const mockToastSuccess = jest.mocked(toast.success)
const mockToastWarning = jest.mocked(toast.warning)

const mockRouter: KNavigationProps = { push: mockPush }

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'document.backToList' ? 'Back to knowledge bases' : key),
    i18n: { language: 'en' },
  }),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParams,
}))

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), warning: jest.fn() },
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
    hasLoadError: false,
    groupKbErrors: {},
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
    onCreateKb: (scope: 'personal', kbType: 'notebook' | 'code_wiki') => void
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
      <button
        type="button"
        data-testid="create-normal-kb"
        onClick={() => onCreateKb('personal', 'notebook')}
      >
        Create KB
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
      <div>
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
              scheduled_update: {
                enabled: true,
                cadence: 'daily',
                interval_days: 1,
                weekday: 0,
                hour: 9,
                minute: 0,
                timezone: 'Asia/Shanghai',
              },
            })
          }
        >
          Submit Code Wiki
        </button>
        <button
          type="button"
          data-testid="submit-normal-kb"
          onClick={() =>
            void onSubmit({
              name: 'Docs',
              description: undefined,
              allow_document_download: false,
              kb_type: 'notebook',
            })
          }
        >
          Submit KB
        </button>
      </div>
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
  codeWikiApi: { create: jest.fn(), configureScheduledUpdate: jest.fn() },
}))

import { createKnowledgeBase, getKnowledgeBase } from '@/apis/knowledge'

jest.mock('@/apis/knowledge', () => {
  const actual = jest.requireActual('@/apis/knowledge')
  const getKnowledgeBase = jest.fn()
  const createKnowledgeBase = jest.fn()
  return {
    __esModule: true,
    ...actual,
    getKnowledgeBase,
    createKnowledgeBase,
  }
})

const mockGetKnowledgeBase = jest.mocked(getKnowledgeBase)
const mockCreateKnowledgeBase = jest.mocked(createKnowledgeBase)
const mockCreateCodeWiki = jest.mocked(codeWikiApi.create)
const mockConfigureScheduledUpdate = jest.mocked(codeWikiApi.configureScheduledUpdate)

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
    selectedKb?: Pick<KnowledgeBase, 'id' | 'name'>
    initialDocPath?: string
  }) => (
    <div data-testid="mock-detail-panel">
      <span data-testid="detail-kb-id">{selectedKb?.id}</span>
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
  hasLoadError: false,
  groupKbErrors: {},
  personalData: null,
  orgKbs: [],
  groupKbMap: {},
  groupKbLoading: {},
  expandState: {},
}

function resetMockTree() {
  mockSearchParams = new URLSearchParams()
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
  mockCreateKnowledgeBase.mockReset()
  mockCreateKnowledgeBase.mockResolvedValue(baseKb)
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
  mockConfigureScheduledUpdate.mockReset()
  mockConfigureScheduledUpdate.mockResolvedValue({} as never)
}

describe('KnowledgeDocumentPageMobile detail view switch', () => {
  beforeEach(() => {
    mockPush.mockReset()
    mockToastSuccess.mockReset()
    mockToastWarning.mockReset()
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

  it('6) code wiki deep-link uses the reader and exposes its top-level view switcher', async () => {
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
      expect.objectContaining({
        visible: true,
        switcher: 'code-wiki',
        currentView: 'wiki',
      })
    )
  })

  it('7) mobile code wiki creation stays in the list after the dedicated API succeeds', async () => {
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
    await waitFor(() => {
      expect(mockTree.refreshPersonal).toHaveBeenCalledTimes(1)
    })
    expect(mockToastSuccess).toHaveBeenCalledWith('codeWiki.create.created')
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('warns when mobile creation succeeds but its scheduled update does not', async () => {
    mockConfigureScheduledUpdate.mockRejectedValue(new Error('schedule unavailable'))
    render(<KnowledgeDocumentPageMobile />)

    await userEvent.click(screen.getByTestId('create-code-wiki'))
    await userEvent.click(screen.getByTestId('submit-code-wiki'))

    await waitFor(() => {
      expect(mockToastWarning).toHaveBeenCalledWith('codeWiki.create.scheduleNotConfigured')
    })
    expect(mockToastSuccess).not.toHaveBeenCalledWith('codeWiki.create.created')
    expect(mockTree.refreshPersonal).toHaveBeenCalledTimes(1)
  })

  it('8) code wiki owners can reach the existing KB configuration dialog', async () => {
    const codeWiki = { ...baseKb, id: 7, name: 'Wegent', kb_type: 'code_wiki' as const }
    mockTree.personalData = { created_by_me: [codeWiki], shared_with_me: [] }
    mockGetKnowledgeBase.mockResolvedValue(codeWiki)

    render(<KnowledgeDocumentPageMobile initialKbNamespace="default" initialKbName="Wegent" />)

    await userEvent.click(await screen.findByTestId('open-code-wiki-config'))

    expect(screen.getByTestId('mock-edit-knowledge-base-dialog')).toBeInTheDocument()
  })

  it('9) normal KB creation forwards the dialog download setting', async () => {
    render(<KnowledgeDocumentPageMobile />)

    await userEvent.click(screen.getByTestId('create-normal-kb'))
    await userEvent.click(screen.getByTestId('submit-normal-kb'))

    await waitFor(() => {
      expect(mockCreateKnowledgeBase).toHaveBeenCalledTimes(1)
    })
    expect(mockCreateKnowledgeBase).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'default',
        kb_type: 'notebook',
        allow_document_download: false,
      })
    )
  })
})

describe('KnowledgeDocumentPageMobile scoped URL resolution', () => {
  beforeEach(resetMockTree)

  it('does not open a same-name team KB when the company list is empty', () => {
    mockTree.groupKbMap = {
      organization: [{ ...baseKb, id: 7, name: 'OrgKB', namespace: 'organization' }],
    }
    render(<KnowledgeDocumentPageMobile initialKbName="OrgKB" />)
    expect(mockGetKnowledgeBase).not.toHaveBeenCalled()
    expect(screen.getByTestId('knowledge-url-not-found')).toBeInTheDocument()
  })

  it('does not choose the first of two company KB IDs with the same name', () => {
    mockTree.orgKbs = [
      { ...baseKb, id: 7, name: 'OrgKB', namespace: 'company' },
      { ...baseKb, id: 8, name: 'OrgKB', namespace: 'company' },
    ]
    render(<KnowledgeDocumentPageMobile initialKbName="OrgKB" />)
    expect(mockGetKnowledgeBase).not.toHaveBeenCalled()
    expect(screen.getByTestId('knowledge-url-ambiguous')).toBeInTheDocument()
  })
})

describe('KnowledgeDocumentPageMobile asynchronous resolution', () => {
  beforeEach(resetMockTree)

  it('waits for the company list and passes its ID to detail rendering', async () => {
    const company = { ...baseKb, id: 202, name: 'OrgKB', namespace: 'company' }
    mockTree.loading = true
    mockTree.personalData = {
      created_by_me: [{ ...company, id: 303, namespace: 'default' }],
      shared_with_me: [],
    }
    const { rerender } = render(<KnowledgeDocumentPageMobile initialKbName="OrgKB" />)
    expect(screen.getByTestId('knowledge-url-loading')).toBeInTheDocument()
    expect(mockGetKnowledgeBase).not.toHaveBeenCalled()
    mockTree.loading = false
    mockTree.orgKbs = [company, company]
    mockGetKnowledgeBase.mockResolvedValue(company)
    rerender(<KnowledgeDocumentPageMobile initialKbName="OrgKB" />)
    expect(await screen.findByTestId('detail-kb-id')).toHaveTextContent('202')
    expect(mockGetKnowledgeBase).toHaveBeenCalledWith(202)
  })

  it('discards an old detail response after navigating to another company KB', async () => {
    const first = { ...baseKb, id: 202, name: 'First', namespace: 'company' }
    const second = { ...baseKb, id: 404, name: 'Second', namespace: 'company' }
    mockTree.orgKbs = [first, second]
    let finishFirst!: (kb: KnowledgeBase) => void
    mockGetKnowledgeBase.mockImplementation(id =>
      id === first.id
        ? new Promise(resolve => {
            finishFirst = resolve
          })
        : Promise.resolve(second)
    )
    const { rerender } = render(<KnowledgeDocumentPageMobile initialKbName="First" />)
    rerender(<KnowledgeDocumentPageMobile initialKbName="Second" />)
    expect(await screen.findByTestId('detail-kb-id')).toHaveTextContent('404')
    await act(async () => finishFirst(first))
    expect(screen.getByTestId('detail-kb-id')).toHaveTextContent('404')
  })

  it('shows a detail error and retries without using list data as detail', async () => {
    const company = { ...baseKb, id: 202, name: 'OrgKB', namespace: 'company' }
    mockTree.orgKbs = [company]
    mockGetKnowledgeBase.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(company)
    render(<KnowledgeDocumentPageMobile initialKbName="OrgKB" />)
    expect(await screen.findByTestId('knowledge-url-error')).toBeInTheDocument()
    expect(screen.queryByTestId('mock-detail-panel')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('knowledge-url-retry'))
    expect(await screen.findByTestId('detail-kb-id')).toHaveTextContent('202')
  })
})

it('shows an initial group-list load failure instead of waiting forever', () => {
  resetMockTree()
  mockTree.hasLoadError = true
  render(<KnowledgeDocumentPageMobile initialKbNamespace="team" initialKbName="Missing" />)
  expect(screen.getByTestId('knowledge-url-error')).toBeInTheDocument()
  expect(screen.queryByTestId('knowledge-url-loading')).not.toBeInTheDocument()
})

it('keeps the mounted company detail during refresh and a failed refresh', async () => {
  resetMockTree()
  const company = { ...baseKb, id: 202, name: 'OrgKB', namespace: 'company' }
  mockTree.orgKbs = [company]
  mockGetKnowledgeBase.mockResolvedValue(company)
  const { rerender } = render(<KnowledgeDocumentPageMobile initialKbName="OrgKB" />)
  const panel = await screen.findByTestId('mock-detail-panel')
  mockTree.loading = true
  rerender(<KnowledgeDocumentPageMobile initialKbName="OrgKB" />)
  expect(screen.getByTestId('mock-detail-panel')).toBe(panel)
  mockTree.loading = false
  mockTree.hasLoadError = true
  rerender(<KnowledgeDocumentPageMobile initialKbName="OrgKB" />)
  expect(screen.getByTestId('mock-detail-panel')).toBe(panel)
  expect(screen.getByTestId('knowledge-url-error')).toBeInTheDocument()
  mockTree.hasLoadError = false
  mockTree.orgKbs = [{ ...company }]
  rerender(<KnowledgeDocumentPageMobile initialKbName="OrgKB" />)
  expect(screen.getByTestId('mock-detail-panel')).toBe(panel)
  expect(mockGetKnowledgeBase).toHaveBeenCalledTimes(1)
})

it('opens the requested same-name ID on mobile and preserves it in a copied URL', async () => {
  resetMockTree()
  const first = { ...baseKb, id: 202, name: 'OrgKB', namespace: 'company' }
  const selected = { ...first, id: 404 }
  mockTree.orgKbs = [first, selected]
  mockSearchParams.set('kb', '404')
  mockGetKnowledgeBase.mockResolvedValue(selected)
  render(<KnowledgeDocumentPageMobile initialKbName="OrgKB" />)
  expect(await screen.findByTestId('detail-kb-id')).toHaveTextContent('404')
  expect(mockGetKnowledgeBase).toHaveBeenCalledWith(404)
})

it('does not fall back to the matching mobile name for an out-of-scope ID', () => {
  resetMockTree()
  const company = { ...baseKb, id: 202, name: 'OrgKB', namespace: 'company' }
  mockTree.orgKbs = [company]
  mockSearchParams.set('kb', '999')
  render(<KnowledgeDocumentPageMobile initialKbName="OrgKB" />)
  expect(screen.getByTestId('knowledge-url-not-found')).toBeInTheDocument()
  expect(mockGetKnowledgeBase).not.toHaveBeenCalled()
})

it('generates a mobile selection URL with the known ID', async () => {
  resetMockTree()
  mockPush.mockClear()
  render(<KnowledgeDocumentPageMobile />)
  await userEvent.click(screen.getByTestId('select-first-kb'))
  expect(mockPush).toHaveBeenCalledWith('/knowledge/default/TestKB?kb=999')
})

it('updates the mobile display name while preserving the selected ID, document path and task', async () => {
  resetMockTree()
  const company = { ...baseKb, id: 202, name: 'New name', namespace: 'company' }
  mockTree.orgKbs = [company]
  mockSearchParams = new URLSearchParams('kb=202&taskId=123&documentId=7')
  mockGetKnowledgeBase.mockResolvedValue(company)
  const replaceState = jest.spyOn(window.history, 'replaceState')
  render(<KnowledgeDocumentPageMobile initialKbName="Old name" initialDocPath="folder/doc.md" />)
  expect(await screen.findByTestId('detail-kb-id')).toHaveTextContent('202')
  const url = new URL(String(replaceState.mock.calls[0][2]), 'https://example.com')
  expect(url.pathname).toBe('/knowledge/public/New%20name/folder/doc.md')
  expect(url.searchParams.get('kb')).toBe('202')
  expect(url.searchParams.get('taskId')).toBe('123')
  expect(url.searchParams.get('documentId')).toBe('7')
  replaceState.mockRestore()
})

it('hides the old mobile detail when the ID changes while lists are loading', async () => {
  resetMockTree()
  const company = { ...baseKb, id: 202, name: 'OrgKB', namespace: 'company' }
  mockTree.orgKbs = [company]
  mockSearchParams.set('kb', '202')
  mockGetKnowledgeBase.mockResolvedValue(company)
  const { rerender } = render(<KnowledgeDocumentPageMobile initialKbName="OrgKB" />)
  await screen.findByTestId('detail-kb-id')
  mockTree.loading = true
  mockSearchParams.set('kb', '404')
  rerender(<KnowledgeDocumentPageMobile initialKbName="OrgKB" />)
  expect(screen.queryByTestId('mock-detail-panel')).not.toBeInTheDocument()
  expect(screen.getByTestId('knowledge-url-loading')).toBeInTheDocument()
})
