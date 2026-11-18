// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiClient, ApiError } from '@/apis/client'
import { modelApis } from '@/apis/models'
import { KnowledgeDetailPanel } from '@/features/knowledge/document/components/KnowledgeDetailPanel'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { UnifiedMessage } from '@wegent/chat-core'
import type { KnowledgeBase } from '@/types/knowledge'
import type { ArtifactPromptRequest } from '@/types/knowledge-artifact'

const mockChatArea = jest.fn()
const mockSourcePanel = jest.fn()
const mockGenerationPanel = jest.fn()
const mockSelectTask = jest.fn()
const mockFetchPermission = jest.fn()
const mockDenyTask = jest.fn()
const mockSetMessageSyncOptions = jest.fn()
const mockTranslate = (key: string, values?: { title?: string; number?: number }) =>
  key === 'evidence.citation_label' ? `${values?.title} · ${values?.number}` : key
let mockSearchParams = new URLSearchParams()
let mockTaskId: number | undefined
let mockMessages = new Map<string, UnifiedMessage>()
let mockUserId = 7
let mockViewport = { mobile: false, desktop: true }

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mockTranslate,
  }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: mockUserId } }),
}))

jest.mock('@/contexts/TeamContext', () => ({
  useTeamContext: () => ({
    teams: [],
    isTeamsLoading: true,
    loadError: new Error('Agent catalog unavailable'),
    refreshTeams: jest.fn().mockResolvedValue([]),
  }),
}))

jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({
    selectTask: mockSelectTask,
    selectedTask: mockTaskId ? { id: mockTaskId } : null,
    selectedTaskDetail: mockTaskId ? { id: mockTaskId, task_type: 'knowledge' } : null,
    currentTaskId: mockTaskId,
    messages: mockMessages,
    taskState: null,
    isStreaming: false,
    streamingSubtaskIds: [],
    setMessageSyncOptions: mockSetMessageSyncOptions,
    denySelectedTaskAccess: mockDenyTask,
  }),
}))

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => mockViewport.mobile,
  useIsDesktop: () => mockViewport.desktop,
}))

jest.mock('@/features/theme/ThemeProvider', () => ({ useTheme: () => ({ theme: 'light' }) }))
jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ registerCorrectionHandlers: jest.fn() }),
}))
jest.mock('@/hooks/useTraceAction', () => ({
  useTraceAction: () => ({
    trace: { event: jest.fn() },
    traced: () => (fn: unknown) => fn,
  }),
}))
jest.mock('@/hooks/useMessageFeedback', () => ({
  useMessageFeedback: () => ({ feedback: null, handleLike: jest.fn(), handleDislike: jest.fn() }),
}))
jest.mock('next/dynamic', () => () => () => null)
jest.mock('react-markdown', () =>
  jest.requireActual('../../../../../node_modules/react-markdown/index.js')
)
jest.mock('rehype-raw', () => jest.requireActual('../../../../../node_modules/rehype-raw/index.js'))

let mockPermission = {
  has_access: true,
  role: 'Developer',
  is_creator: false,
  source_access: 'readable',
  task_source_bound: false,
}

jest.mock('@/features/knowledge/permission/hooks/useKnowledgePermissions', () => ({
  useKnowledgePermissions: () => ({
    myPermission: mockPermission,
    fetchMyPermission: mockFetchPermission,
  }),
}))

jest.mock('@/features/knowledge/document/hooks/useNamespaceRoleMap', () => ({
  useNamespaceRoleMap: () => new Map(),
}))

jest.mock('@/utils/namespace-permissions', () => ({
  canManageKnowledgeBase: () => true,
  canManageKnowledgeBaseDocuments: () => true,
  canManageKnowledgeBasePermissions: () => true,
}))

jest.mock('@/features/tasks/components/chat', () => ({
  ChatArea: (props: { selectedDocumentIds: number[] }) => {
    mockChatArea(props)
    const MessagesArea = jest.requireActual(
      '@/features/tasks/components/message/MessagesArea'
    ).default
    if (mockMessages.size > 0) {
      return (
        <TooltipProvider>
          <MessagesArea currentTaskId={mockTaskId} hasMessages />
          <textarea aria-label="聊天草稿" />
        </TooltipProvider>
      )
    }
    return <div data-testid="mock-chat-area" />
  },
}))

jest.mock('@/features/knowledge/document/components/KnowledgeSourcePanel', () => ({
  KnowledgeSourcePanel: (props: {
    selectedDocumentIds: number[]
    mobileVisible: boolean
    onDocumentSelectionChange: (documentIds: number[]) => void
  }) => {
    mockSourcePanel(props)
    return (
      <button
        data-testid="mock-source-panel"
        onClick={() => props.onDocumentSelectionChange([11, 12])}
      />
    )
  },
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactWorkspacePanel', () => ({
  ArtifactWorkspacePanel: (props: {
    selectedDocumentIds: number[]
    mobileVisible: boolean
    onAskNode?: (request: ArtifactPromptRequest) => void
  }) => {
    mockGenerationPanel(props)
    return (
      <div>
        <input aria-label="生成草稿" />
        <button
          data-testid="mock-generation-panel"
          onClick={() =>
            props.onAskNode?.({
              requestId: 'request-1',
              message: 'Explain this node',
              artifactContext: {
                artifact_id: 'artifact-1',
                node_id: 'node-1',
              },
            })
          }
        />
      </div>
    )
  },
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactSourceDialog', () => ({
  ArtifactSourceDialog: () => null,
}))

jest.mock('@/features/knowledge/document/components/KnowledgeBaseSummaryCard', () => ({
  KnowledgeBaseSummaryCard: () => null,
}))

jest.mock('@/features/knowledge/document/components/DocumentList', () => ({
  DocumentList: ({ headerActions }: { headerActions?: React.ReactNode }) => (
    <div data-testid="mock-classic-document-list">{headerActions}</div>
  ),
}))

jest.mock('@/features/knowledge/document/components/KnowledgeAccessDialog', () => ({
  KnowledgeAccessDialog: ({
    canManage,
    onChanged,
    onClose,
  }: {
    canManage: boolean
    onChanged: () => void
    onClose: () => void
  }) => (
    <div role="dialog">
      {canManage && (
        <button data-testid="mock-classic-permissions" onClick={onChanged}>
          Change permission
        </button>
      )}
      <button onClick={onClose}>Close permission dialog</button>
    </div>
  ),
}))

jest.mock('@/apis/knowledge', () => ({
  getKnowledgeBase: jest.fn(),
}))

const knowledgeBase: KnowledgeBase = {
  id: 12,
  name: 'workspace-kb',
  description: null,
  user_id: 7,
  namespace: 'default',
  document_count: 3,
  is_active: true,
  summary_enabled: false,
  max_calls_per_conversation: 10,
  exempt_calls_before_check: 0,
  created_at: '2026-07-28T00:00:00Z',
  updated_at: '2026-07-28T00:00:00Z',
}

beforeEach(() => {
  jest.spyOn(modelApis, 'getUnifiedModels').mockResolvedValue({ data: [] })
  mockTaskId = undefined
  mockMessages = new Map()
  mockSearchParams = new URLSearchParams()
  mockViewport = { mobile: false, desktop: true }
  mockUserId = 7
  mockPermission = {
    has_access: true,
    role: 'Developer',
    is_creator: false,
    source_access: 'readable',
    task_source_bound: false,
  }
})

afterEach(() => jest.restoreAllMocks())

describe('KnowledgeDetailPanel workspace', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shares one source scope across the source, chat, and generation columns', () => {
    render(<KnowledgeDetailPanel selectedKb={knowledgeBase} currentView="notebook" />)

    expect(screen.getByTestId('knowledge-detail-notebook')).toHaveClass(
      'border-t',
      'border-border',
      'lg:flex-row'
    )
    expect(screen.getByTestId('knowledge-workspace-chat')).toHaveClass('lg:flex')
    expect(screen.getByTestId('knowledge-mobile-sources-tab')).toHaveClass('h-11')
    expect(screen.getByTestId('knowledge-mobile-chat-tab')).toHaveClass('h-11')
    expect(screen.getByTestId('knowledge-mobile-generation-tab')).toHaveClass('h-11')
    expect(screen.getByTestId('mock-source-panel')).toBeInTheDocument()
    expect(screen.getByTestId('mock-chat-area')).toBeInTheDocument()
    expect(screen.getByTestId('mock-generation-panel')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('mock-source-panel'))

    expect(mockChatArea).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedDocumentIds: [11, 12] })
    )
    expect(mockGenerationPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedDocumentIds: [11, 12] })
    )
  })

  it('switches among sources, chat, and generation below the three-column breakpoint', () => {
    render(<KnowledgeDetailPanel selectedKb={knowledgeBase} currentView="notebook" />)

    expect(mockSourcePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ mobileVisible: false })
    )
    expect(mockGenerationPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ mobileVisible: false })
    )

    fireEvent.mouseDown(screen.getByTestId('knowledge-mobile-sources-tab'), { button: 0 })
    expect(mockSourcePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ mobileVisible: true })
    )

    fireEvent.mouseDown(screen.getByTestId('knowledge-mobile-generation-tab'), { button: 0 })
    expect(mockGenerationPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ mobileVisible: true })
    )

    fireEvent.click(screen.getByTestId('mock-generation-panel'))
    expect(mockChatArea).toHaveBeenLastCalledWith(
      expect.objectContaining({
        externalPromptRequest: expect.objectContaining({ requestId: 'request-1' }),
      })
    )
  })
})

it('exits the classic permission view when the list confirms management downgrade', () => {
  const classic = { ...knowledgeBase, kb_type: 'classic' as const }
  const { rerender } = render(
    <KnowledgeDetailPanel selectedKb={classic} currentView="documents" verifiedRole="Maintainer" />
  )
  const trigger = screen.getByTestId('knowledge-detail-permissions-tab')
  expect(trigger).toHaveClass('min-h-11', 'min-w-11')
  fireEvent.click(trigger)
  expect(screen.getByTestId('mock-classic-permissions')).toBeInTheDocument()
  const calls = mockFetchPermission.mock.calls.length
  rerender(
    <KnowledgeDetailPanel selectedKb={classic} currentView="documents" verifiedRole="Reporter" />
  )
  expect(screen.queryByTestId('knowledge-detail-permissions-tab')).not.toBeInTheDocument()
  expect(screen.queryByTestId('mock-classic-permissions')).not.toBeInTheDocument()
  expect(mockFetchPermission.mock.calls.length).toBeGreaterThan(calls)
})

it('renders the current chat actions and clears them when switching libraries', () => {
  const action = jest.fn()
  const { rerender } = render(
    <KnowledgeDetailPanel selectedKb={knowledgeBase} currentView="notebook" />
  )
  const oldChat = mockChatArea.mock.calls.at(-1)![0]
  expect(oldChat.onShareButtonRender).toEqual(expect.any(Function))
  act(() => oldChat.onShareButtonRender(<button onClick={action}>Export current chat</button>))
  fireEvent.click(screen.getByRole('button', { name: 'Export current chat' }))
  expect(action).toHaveBeenCalledTimes(1)
  act(() => oldChat.onShareButtonRender(<button>Export next conversation</button>))
  expect(screen.queryByText('Export current chat')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Export next conversation' })).toBeInTheDocument()
  act(() => oldChat.onShareButtonRender(null))
  expect(screen.queryByTestId('knowledge-chat-actions')).not.toBeInTheDocument()
  rerender(
    <KnowledgeDetailPanel selectedKb={{ ...knowledgeBase, id: 99 }} currentView="notebook" />
  )
  expect(screen.queryByRole('button', { name: 'Export current chat' })).not.toBeInTheDocument()
  act(() => oldChat.onShareButtonRender(<button>Obsolete export</button>))
  expect(screen.queryByText('Obsolete export')).not.toBeInTheDocument()
})

it('keeps the document list mounted while permissions are open', () => {
  const classic = { ...knowledgeBase, kb_type: 'classic' as const }
  render(
    <KnowledgeDetailPanel selectedKb={classic} currentView="documents" verifiedRole="Maintainer" />
  )
  const list = screen.getByTestId('mock-classic-document-list')
  fireEvent.mouseDown(screen.getByTestId('knowledge-detail-permissions-tab'), { button: 0 })
  fireEvent.click(screen.getByTestId('knowledge-detail-permissions-tab'))
  expect(screen.getByTestId('mock-classic-document-list')).toBe(list)
})

it.each(['documents', 'notebook'] as const)(
  'does not offer a workspace chat when the library is visit-only (%s)',
  currentView => {
    const onAccessLost = jest.fn()
    const originalPermission = mockPermission
    mockPermission = { ...mockPermission, has_access: false, source_access: 'visit-only' }
    try {
      render(
        <KnowledgeDetailPanel
          selectedKb={knowledgeBase}
          currentView={currentView}
          onAccessLost={onAccessLost}
        />
      )
      expect(screen.queryByTestId('mock-chat-area')).not.toBeInTheDocument()
      expect(onAccessLost).toHaveBeenCalled()
    } finally {
      mockPermission = originalPermission
    }
  }
)

const notebookCitation = {
  citation_id: '42',
  knowledge_base_id: 12,
  document_id: 11,
  title: '工作台资料',
}

function showNotebookAnswer({
  blocks = false,
  mixed = false,
}: { blocks?: boolean; mixed?: boolean } = {}) {
  mockTaskId = 3
  mockSearchParams = new URLSearchParams('taskId=3')
  const other = { ...notebookCitation, citation_id: '43', ...(mixed && { knowledge_base_id: 8 }) }
  const message = {
    id: 'answer-21',
    type: 'ai',
    status: 'completed',
    subtaskStatus: 'COMPLETED',
    subtaskId: 21,
    timestamp: 1234,
    content: '已提交回答[[citation:42]]',
    result: {
      answer_generation_id: 'a'.repeat(32),
      answer_citations: [notebookCitation, other],
      ...(mixed && { sources: [{ index: 1, kb_id: 12, title: '受限资料' }] }),
      ...(blocks && {
        blocks: [
          { id: 'a', type: 'text', content: '已提交回答[[citation:42]]' },
          { id: 'b', type: 'text', content: '另一个片段[[citation:43]]，重复[[citation:42]]' },
        ],
      }),
    },
  } satisfies UnifiedMessage & { result: Record<string, unknown> }
  mockMessages = new Map([[message.id, message]])
}

it('uses the space after sources for a single evidence panel and preserves workspace state', async () => {
  showNotebookAnswer({ blocks: true })
  jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  const get = jest.spyOn(apiClient, 'get').mockImplementation(async url => {
    if (url.includes('my-permission')) return { source_access: 'readable' }
    return {
      ...notebookCitation,
      citation_id: url.includes('/43?') ? '43' : '42',
      content: url.includes('/43?') ? '引用片段二' : '引用片段一',
    }
  })
  render(<KnowledgeDetailPanel selectedKb={knowledgeBase} currentView="notebook" />)
  const user = userEvent.setup()
  const generationDraft = screen.getByRole('textbox', { name: '生成草稿' })
  const chatDraft = screen.getByRole('textbox', { name: '聊天草稿' })
  fireEvent.change(generationDraft, { target: { value: '生成设置' } })
  fireEvent.change(chatDraft, { target: { value: '聊天内容' } })
  fireEvent.click(screen.getByTestId('mock-source-panel'))

  const [first, repeated] = screen.getAllByTestId('answer-citation-42')
  expect(first).toHaveAccessibleName('工作台资料 · 1')
  expect(repeated).toHaveAccessibleName('工作台资料 · 1')
  expect(screen.getByTestId('answer-citation-43')).toHaveAccessibleName('工作台资料 · 2')
  await act(async () => first.focus())
  expect(await screen.findByTestId('answer-evidence-preview-content')).toHaveTextContent(
    '引用片段一'
  )
  await user.keyboard('{Enter}')
  const panel = await screen.findByTestId('answer-evidence-panel')
  expect(panel).toHaveAttribute('data-layout', 'side')
  expect(panel).toHaveAttribute('data-version-status', 'unknown')
  expect(generationDraft).not.toBeVisible()
  expect(screen.getByTestId('mock-source-panel')).toBeVisible()
  expect(await screen.findByTestId('answer-evidence-content')).toHaveTextContent('引用片段一')
  fireEvent.change(screen.getByTestId('answer-evidence-select-fragment'), {
    target: { value: '43' },
  })
  expect(await screen.findByTestId('answer-evidence-content')).toHaveTextContent('引用片段二')
  expect(screen.getAllByTestId('answer-evidence-panel')).toHaveLength(1)
  fireEvent.click(screen.getByTestId('answer-evidence-close'))
  expect(first).toHaveFocus()
  expect(chatDraft).toHaveValue('聊天内容')
  expect(generationDraft).toBeVisible()
  expect(generationDraft).toHaveValue('生成设置')
  expect(mockChatArea).toHaveBeenLastCalledWith(
    expect.objectContaining({ selectedDocumentIds: [11, 12] })
  )

  fireEvent.click(first)
  await screen.findByTestId('answer-evidence-content')
  expect(get.mock.calls.map(([url]) => url).filter(url => !url.includes('my-permission'))).toEqual([
    '/knowledge-bases/citations/42?answer_id=21&generation_id=' + 'a'.repeat(32),
    '/knowledge-bases/citations/42?answer_id=21&generation_id=' + 'a'.repeat(32),
    '/knowledge-bases/citations/43?answer_id=21&generation_id=' + 'a'.repeat(32),
    '/knowledge-bases/citations/42?answer_id=21&generation_id=' + 'a'.repeat(32),
  ])
})

it.each([
  { layout: 'overlay', mobile: false },
  { layout: 'mobile', mobile: true },
])(
  'opens a $layout panel and retries a temporary failure without losing work',
  async ({ layout, mobile }) => {
    showNotebookAnswer()
    mockViewport = { desktop: !mobile, mobile }
    jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    let snapshotReads = 0
    jest.spyOn(apiClient, 'get').mockImplementation(async url => {
      if (url.includes('my-permission')) return { source_access: 'readable' }
      if (++snapshotReads === 1) throw new ApiError('Try again', 503)
      return { ...notebookCitation, content: '恢复后的片段' }
    })
    render(<KnowledgeDetailPanel selectedKb={knowledgeBase} currentView="notebook" />)
    const trigger = screen.getByTestId('answer-citation-42')
    fireEvent.click(screen.getByTestId('mock-source-panel'))
    fireEvent.click(trigger)
    expect(await screen.findByTestId('answer-evidence-panel')).toHaveAttribute(
      'data-layout',
      layout
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('evidence.read_failed')
    expect(screen.getByText(/已提交回答/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('answer-evidence-retry-read_failed'))
    expect(await screen.findByText('恢复后的片段')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('answer-evidence-close'))
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(snapshotReads).toBe(2)
    expect(mockGenerationPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedDocumentIds: [11, 12] })
    )
    expect(screen.getByTestId('knowledge-mobile-chat-tab')).toHaveAttribute('aria-selected', 'true')
  }
)

it.each([
  { sourceAccess: 'visit-only', notice: 'partial_visit_only' },
  { sourceAccess: 'denied', notice: 'source_denied' },
])(
  'keeps authorized history read-only when workspace source access is $sourceAccess',
  async ({ sourceAccess, notice }) => {
    showNotebookAnswer({ blocks: true, mixed: true })
    mockPermission = { ...mockPermission, has_access: false, task_source_bound: true }
    const get = jest.spyOn(apiClient, 'get').mockImplementation(async url => {
      if (url.includes('/12/my-permission?task_id=3')) return { source_access: sourceAccess }
      if (url.includes('/8/my-permission?task_id=3')) return { source_access: 'readable' }
      return {
        ...notebookCitation,
        citation_id: '43',
        knowledge_base_id: 8,
        content: '另一来源的片段',
      }
    })
    const onAccessLost = jest.fn()
    render(
      <TooltipProvider>
        <KnowledgeDetailPanel
          selectedKb={knowledgeBase}
          currentView="notebook"
          onAccessLost={onAccessLost}
        />
      </TooltipProvider>
    )
    await waitFor(() =>
      expect(screen.getByTestId('answer-source-access')).toHaveTextContent(notice)
    )
    expect(screen.getAllByTestId('answer-source-access')).toHaveLength(1)
    expect(screen.getByText(/已提交回答/)).toBeInTheDocument()
    expect(screen.queryByTestId('mock-source-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mock-generation-panel')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '聊天草稿' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('answer-citation-42')).not.toBeInTheDocument()
    expect(screen.getByTestId('answer-citation-43')).toHaveAccessibleName('工作台资料 · 2')
    expect(onAccessLost).not.toHaveBeenCalled()
    expect(get.mock.calls.every(([url]) => url.includes('my-permission'))).toBe(true)
    fireEvent.click(screen.getByTestId('answer-citation-43'))
    expect(await screen.findByText('另一来源的片段')).toBeInTheDocument()
  }
)

it.each(['library', 'task', 'account', 'backend'] as const)(
  'discards a late snapshot after switching %s',
  async scope => {
    showNotebookAnswer()
    let resolveSnapshot!: (snapshot: object) => void
    let signal: AbortSignal | undefined
    let backendScope = 'test-backend'
    jest.spyOn(apiClient, 'getCacheScope').mockImplementation(() => backendScope)
    jest.spyOn(apiClient, 'get').mockImplementation(async (url, options) => {
      if (url.includes('my-permission')) return { source_access: 'readable' }
      if (!url.includes('/citations/')) return undefined
      signal = options?.signal
      return new Promise(resolve => {
        resolveSnapshot = resolve
      })
    })
    const { rerender } = render(
      <KnowledgeDetailPanel selectedKb={knowledgeBase} currentView="notebook" />
    )
    fireEvent.click(screen.getByTestId('answer-citation-42'))
    expect(await screen.findByTestId('answer-evidence-panel')).toBeInTheDocument()
    if (scope === 'task') {
      mockTaskId = 9
      mockSearchParams = new URLSearchParams('taskId=9')
    }
    if (scope === 'account') mockUserId = 9
    if (scope === 'backend') backendScope = 'another-backend'
    const nextLibrary = scope === 'library' ? { ...knowledgeBase, id: 99 } : knowledgeBase
    rerender(<KnowledgeDetailPanel selectedKb={nextLibrary} currentView="notebook" />)
    expect(signal?.aborted).toBe(true)
    await act(async () => resolveSnapshot({ ...notebookCitation, content: '旧作用域快照' }))
    await waitFor(() =>
      expect(screen.queryByTestId('answer-evidence-panel')).not.toBeInTheDocument()
    )
    expect(screen.queryByText('旧作用域快照')).not.toBeInTheDocument()
  }
)

it('withholds history and source controls when the server does not confirm the task binding', () => {
  showNotebookAnswer()
  mockPermission = { ...mockPermission, has_access: false, task_source_bound: false }
  const get = jest.spyOn(apiClient, 'get')
  render(<KnowledgeDetailPanel selectedKb={knowledgeBase} currentView="notebook" />)
  expect(screen.getByTestId('knowledge-url-not-found')).toBeInTheDocument()
  expect(screen.queryByText(/已提交回答/)).not.toBeInTheDocument()
  expect(screen.queryByTestId('mock-source-panel')).not.toBeInTheDocument()
  expect(get).not.toHaveBeenCalled()
})

it('keeps desktop evidence open after shrinking to a phone with a previous generation tab', async () => {
  showNotebookAnswer()
  jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  jest
    .spyOn(apiClient, 'get')
    .mockImplementation(async url =>
      url.includes('my-permission')
        ? { source_access: 'readable' }
        : { ...notebookCitation, content: '工作台核验证据' }
    )
  const workspace = <KnowledgeDetailPanel selectedKb={knowledgeBase} currentView="notebook" />
  const { rerender } = render(workspace)
  fireEvent.mouseDown(screen.getByTestId('knowledge-mobile-generation-tab'), { button: 0 })
  expect(screen.getByTestId('knowledge-mobile-generation-tab')).toHaveAttribute(
    'aria-selected',
    'true'
  )
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  expect(await screen.findByText('工作台核验证据')).toBeInTheDocument()
  expect(screen.getByTestId('answer-evidence-panel')).toHaveAttribute('data-layout', 'side')

  mockViewport = { desktop: false, mobile: true }
  rerender(<KnowledgeDetailPanel selectedKb={knowledgeBase} currentView="notebook" />)
  expect(screen.getByTestId('answer-evidence-panel')).toHaveAttribute('data-layout', 'mobile')
  expect(screen.getByText('工作台核验证据')).toBeInTheDocument()
})
