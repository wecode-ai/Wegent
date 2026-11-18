import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AnswerEvidenceMarkdown from '@/features/tasks/components/message/evidence/AnswerEvidenceMarkdown'
import { apiClient, ApiError } from '@/apis/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import MessageBubble, { type Message } from '@/features/tasks/components/message/MessageBubble'
import {
  TaskSourceDecisions,
  useTaskSourceDecisions,
  WorkspaceSourceAccess,
} from '@/features/tasks/components/message/evidence/sourceAccess'
import { stripAnswerEvidenceMarkers } from '@/features/tasks/utils/answerEvidenceMarkers'

let currentUser = 1
let currentBackend = 'user:1'
jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: currentUser } }),
}))

jest.mock('@/apis/client', () => {
  const actual = jest.requireActual('@/apis/client')
  const client = { get: jest.fn(), getCacheScope: () => currentBackend }
  return { ...actual, __esModule: true, apiClient: client, default: client }
})
jest.mock('@/hooks/useTraceAction', () => ({
  useTraceAction: () => ({ trace: { event: jest.fn(), copy: jest.fn(), download: jest.fn() } }),
}))
jest.mock('@/hooks/useMessageFeedback', () => ({
  useMessageFeedback: () => ({ feedback: null, handleLike: jest.fn(), handleDislike: jest.fn() }),
}))
jest.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
jest.mock('@/features/knowledge/document/components/DocumentDetailDialog', () => ({
  DocumentDetailDialog: ({ allowDownload }: { allowDownload: boolean }) => (
    <div data-testid="current-original" data-download-allowed={String(allowDownload)} />
  ),
}))
jest.mock('react-markdown', () =>
  jest.requireActual('../../../../../../../node_modules/react-markdown/index.js')
)
jest.mock('rehype-raw', () =>
  jest.requireActual('../../../../../../../node_modules/rehype-raw/index.js')
)
jest.mock('next/dynamic', () => () => () => null)

const evidence = {
  answerId: 12,
  committed: true,
  generationId: 'a'.repeat(32),
  citations: [{ citation_id: '42', title: '资料', knowledge_base_id: 7, document_id: 9 }],
}
const get = apiClient.get as jest.Mock

beforeEach(() => {
  get.mockReset()
  currentUser = 1
  currentBackend = 'user:1'
})

test('opens a committed citation and reauthorizes every reopen', async () => {
  get.mockResolvedValue({
    citation_id: '42',
    content: '回答时正文',
    knowledge_base_id: 7,
    document_id: 9,
  })
  render(<AnswerEvidenceMarkdown source="结论[[citation:42]]" theme="light" evidence={evidence} />)
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  expect(await screen.findByText('回答时正文')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('answer-evidence-close'))
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
})

test('streaming, unavailable, code, links and HTML never request evidence', () => {
  render(
    <AnswerEvidenceMarkdown
      source={
        '[[citation:42]] [[evidence-unavailable]] `[[citation:42]]` [link [[citation:42]]](https://example.com) <b>[[citation:42]]</b>'
      }
      theme="light"
      evidence={{ ...evidence, committed: false }}
    />
  )
  expect(screen.queryByTestId('answer-citation-42')).not.toBeInTheDocument()
  expect(get).not.toHaveBeenCalled()
})

test('late response from another answer is discarded', async () => {
  let resolve!: (value: unknown) => void
  get.mockReturnValue(
    new Promise(r => {
      resolve = r
    })
  )
  const { rerender } = render(
    <AnswerEvidenceMarkdown source="[[citation:42]]" theme="light" evidence={evidence} />
  )
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  rerender(
    <AnswerEvidenceMarkdown
      source="[[citation:42]]"
      theme="light"
      evidence={{ ...evidence, answerId: 13 }}
    />
  )
  resolve({ content: '旧回答正文' })
  await waitFor(() => expect(screen.queryByText('旧回答正文')).not.toBeInTheDocument())
})

test('complete answer does not issue buttons from code links or raw HTML', () => {
  render(
    <AnswerEvidenceMarkdown
      source={
        '[[citation:42]] `[[citation:42]]` [link [[citation:42]]](https://example.com) <b>[[citation:42]]</b> <answer-citation citationId="42"></answer-citation>'
      }
      theme="light"
      evidence={evidence}
    />
  )
  expect(screen.getAllByTestId('answer-citation-42')).toHaveLength(1)
})

test('failed reopen clears the previously authorized body', async () => {
  get.mockResolvedValueOnce({
    citation_id: '42',
    content: '上次正文',
    knowledge_base_id: 7,
    document_id: 9,
  })
  render(<AnswerEvidenceMarkdown source="[[citation:42]]" theme="light" evidence={evidence} />)
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  expect(await screen.findByText('上次正文')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('answer-evidence-close'))
  get.mockRejectedValueOnce(new Error('revoked'))
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  expect(await screen.findByRole('alert')).toHaveTextContent('evidence.read_failed')
  expect(screen.queryByText('上次正文')).not.toBeInTheDocument()
})

test('HTML void tags do not consume the ordinary text following them', () => {
  render(
    <AnswerEvidenceMarkdown source={'说明<br>[[citation:42]]'} theme="light" evidence={evidence} />
  )
  expect(screen.getByTestId('answer-citation-42')).toBeInTheDocument()
})

test('current original loads independently with explicit download policy', async () => {
  get
    .mockResolvedValueOnce({
      citation_id: '42',
      content: '快照正文',
      knowledge_base_id: 7,
      document_id: 9,
    })
    .mockResolvedValueOnce({ content: '快照正文', knowledge_base_id: 7, document_id: 9 })
    .mockResolvedValueOnce({ id: 9, kind_id: 7, name: '当前资料' })
    .mockResolvedValueOnce({ original_download_allowed: false })
  render(<AnswerEvidenceMarkdown source="[[citation:42]]" theme="light" evidence={evidence} />)
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  await screen.findByText('快照正文')
  fireEvent.click(screen.getByTestId('answer-evidence-open-original'))
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      '/knowledge-bases/7/document-protection?preview_watermark=true',
      { signal: expect.any(AbortSignal) }
    )
  )
  expect(get).toHaveBeenCalledWith('/knowledge-documents/9', { signal: expect.any(AbortSignal) })
  expect(await screen.findByTestId('current-original')).toHaveAttribute(
    'data-download-allowed',
    'false'
  )
  expect(screen.getByText('快照正文')).toBeInTheDocument()
})

test('removing the selected citation clears its authorized body immediately', async () => {
  get.mockResolvedValueOnce({ content: '前一引用正文' })
  const { rerender } = render(
    <AnswerEvidenceMarkdown source="[[citation:42]]" theme="light" evidence={evidence} />
  )
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  await screen.findByText('前一引用正文')
  rerender(
    <AnswerEvidenceMarkdown
      source="[[evidence-unavailable]]"
      theme="light"
      evidence={{ ...evidence, citations: [] }}
    />
  )
  expect(screen.queryByText('前一引用正文')).not.toBeInTheDocument()
  expect(screen.queryByTestId('answer-evidence-panel')).not.toBeInTheDocument()
})

test('same-title references switch independently and discard late responses', async () => {
  let late!: (value: unknown) => void
  get
    .mockReturnValueOnce(
      new Promise(resolve => {
        late = resolve
      })
    )
    .mockResolvedValueOnce({ content: '第二文档原文' })
  render(
    <AnswerEvidenceMarkdown
      source="[[citation:42]][[citation:43]][[citation:42]][[evidence-unavailable]]"
      theme="light"
      evidence={{
        ...evidence,
        citations: [
          ...evidence.citations,
          { ...evidence.citations[0], citation_id: '43', document_id: 10 },
        ],
      }}
    />
  )
  expect(screen.getAllByTestId('answer-citation-42')).toHaveLength(2)
  fireEvent.click(screen.getAllByTestId('answer-citation-42')[0])
  fireEvent.click(screen.getByTestId('answer-citation-43'))
  await screen.findByText('第二文档原文')
  await act(async () => {
    late({ content: '迟到第一文档' })
  })
  await waitFor(() => expect(screen.queryByText('迟到第一文档')).not.toBeInTheDocument())
  expect(screen.getByText('第二文档原文')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('answer-evidence-unavailable'))
  expect(get).toHaveBeenCalledTimes(2)
})

test.each(['account', 'backend', 'generation', 'answer', 'task', 'workspace'] as const)(
  'scope switch %s clears body and ignores pending reads',
  async change => {
    let late!: (value: unknown) => void
    get.mockResolvedValueOnce({ content: '原作用域正文' })
    const { rerender } = render(
      <AnswerEvidenceMarkdown source="[[citation:42]]" theme="light" evidence={evidence} />
    )
    fireEvent.click(screen.getByTestId('answer-citation-42'))
    await screen.findByText('原作用域正文')
    get.mockReturnValueOnce(
      new Promise(resolve => {
        late = resolve
      })
    )
    fireEvent.click(screen.getByTestId('answer-citation-42'))
    if (change === 'account') currentUser = 2
    if (change === 'backend') currentBackend = 'backend:2'
    const next = {
      ...evidence,
      answerId: change === 'answer' ? 13 : evidence.answerId,
      generationId: change === 'generation' ? 'b'.repeat(32) : evidence.generationId,
      taskId: change === 'task' ? 5 : undefined,
      workspaceId: change === 'workspace' ? 7 : undefined,
    }
    rerender(<AnswerEvidenceMarkdown source="[[citation:42]]" theme="light" evidence={next} />)
    expect(screen.queryByTestId('answer-evidence-panel')).not.toBeInTheDocument()
    await act(async () => {
      late({ content: '迟到作用域正文' })
    })
    expect(screen.queryByText('迟到作用域正文')).not.toBeInTheDocument()
    expect(screen.queryByText('原作用域正文')).not.toBeInTheDocument()
  }
)

test('original read failure remains independent from authorized snapshot', async () => {
  get
    .mockResolvedValueOnce({ content: '可核验快照', document_id: 9, knowledge_base_id: 7 })
    .mockResolvedValueOnce({ content: '可核验快照', document_id: 9, knowledge_base_id: 7 })
    .mockRejectedValueOnce(new Error('original unavailable'))
    .mockResolvedValueOnce({ original_download_allowed: false })
  render(<AnswerEvidenceMarkdown source="[[citation:42]]" theme="light" evidence={evidence} />)
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  await screen.findByText('可核验快照')
  fireEvent.click(screen.getByTestId('answer-evidence-open-original'))
  expect(await screen.findByRole('alert')).toHaveTextContent('evidence.original_failed')
  expect(screen.getByText('可核验快照')).toBeInTheDocument()
})

test('confirmed visit-only hides the matching historical marker without a content read', () => {
  const restricted = { ...evidence, sourceAccess: { 7: 'visit-only' } as const }
  render(
    <AnswerEvidenceMarkdown source="授权回答[[citation:42]]" theme="light" evidence={restricted} />
  )
  expect(screen.getByText('授权回答')).toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.queryByTestId('answer-evidence-unavailable')).not.toBeInTheDocument()
  expect(get).not.toHaveBeenCalled()
})

const message: Message = {
  type: 'ai',
  content: '${$$}$授权回答[[citation:42]]，另有说明[[citation:43]]。',
  timestamp: 1,
  subtaskId: evidence.answerId,
  subtaskStatus: 'COMPLETED',
  result: {
    answer_generation_id: evidence.generationId,
    answer_citations: [
      ...evidence.citations,
      { citation_id: '43', knowledge_base_id: 8, document_id: 10, title: '可读引用' },
    ],
    sources: [
      { index: 1, kb_id: 7, title: '受限汇总' },
      { index: 2, kb_id: 8, title: '可读汇总' },
    ],
    retrieval_summary: {
      searched_source_ids: ['7', '8'],
      source_statuses: [
        { provider: 'internal', source_id: '7', status: 'hit', record_count: 1, citation_count: 1 },
        { provider: 'internal', source_id: '8', status: 'hit', record_count: 1, citation_count: 1 },
      ],
    },
  },
}

function Answer({ msg = message, taskId = 3 }: { msg?: Message; taskId?: number }) {
  return (
    <TooltipProvider>
      <MessageBubble
        msg={msg}
        index={0}
        currentTaskId={taskId}
        selectedTaskDetail={null}
        theme="light"
        t={key => key}
      />
    </TooltipProvider>
  )
}

test('ordinary chat resolves mixed sources independently and preserves the visible source index', async () => {
  get.mockImplementation((url: string) =>
    Promise.resolve(
      url.includes('/7/my-permission')
        ? { source_access: 'visit-only' }
        : url.includes('/8/my-permission')
          ? { source_access: 'readable' }
          : { citation_id: '43', knowledge_base_id: 8, document_id: 10, content: '可读片段' }
    )
  )
  render(<Answer />)
  expect(await screen.findByTestId('answer-source-access')).toHaveTextContent('partial_visit_only')
  expect(screen.getAllByTestId('answer-source-access')).toHaveLength(1)
  expect(screen.getByText(/授权回答/)).toBeInTheDocument()
  expect(screen.queryByTestId('answer-citation-42')).not.toBeInTheDocument()
  expect(screen.queryByText('受限汇总')).not.toBeInTheDocument()
  expect(screen.getByText('[2]')).toBeInTheDocument()
  expect(get.mock.calls.map(([url]) => url)).toEqual([
    '/share/KnowledgeBase/7/my-permission?task_id=3',
    '/share/KnowledgeBase/8/my-permission?task_id=3',
  ])
  fireEvent.click(screen.getByTestId('answer-citation-43'))
  expect(await screen.findByText('可读片段')).toBeInTheDocument()
  expect(message.content).toContain('[[citation:42]]')
})

test('a new workbench permission clears the original and discards late reads before recovery', async () => {
  let resolveDocument!: (document: unknown) => void
  get.mockImplementation((url: string) => {
    if (url.includes('/8/my-permission')) return Promise.resolve({ source_access: 'readable' })
    if (url.includes('/citations/42')) {
      return Promise.resolve({
        citation_id: '42',
        knowledge_base_id: 7,
        document_id: 9,
        content: '先前片段',
      })
    }
    if (url.includes('/document-protection'))
      return Promise.resolve({ original_download_allowed: true })
    return new Promise(resolve => {
      resolveDocument = resolve
    })
  })
  const view = (access: 'readable' | 'visit-only') => (
    <WorkspaceSourceAccess.Provider value={{ knowledgeBaseId: 7, access, revision: 1 }}>
      <Answer />
    </WorkspaceSourceAccess.Provider>
  )
  const { rerender } = render(view('readable'))
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  await screen.findByText('先前片段')
  fireEvent.click(screen.getByTestId('answer-evidence-open-original'))
  await waitFor(() => expect(resolveDocument).toBeDefined())
  rerender(view('visit-only'))
  expect(screen.getByTestId('answer-source-access')).toHaveTextContent('partial_visit_only')
  expect(screen.queryByText('先前片段')).not.toBeInTheDocument()
  expect(screen.queryByText('受限汇总')).not.toBeInTheDocument()
  expect(screen.queryByTestId('answer-evidence-panel')).not.toBeInTheDocument()
  await act(async () => resolveDocument({ kind_id: 7, id: 9 }))
  expect(screen.queryByTestId('current-original')).not.toBeInTheDocument()
  expect(get.mock.calls.some(([url]) => url.includes('/7/my-permission'))).toBe(false)

  rerender(view('readable'))
  expect(screen.queryByText('先前片段')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  await screen.findByText('先前片段')
  expect(get.mock.calls.filter(([url]) => url.includes('/citations/42'))).toHaveLength(3)
})

test.each(['source', 'answer', undefined] as const)(
  'a citation 403 clears only the authorization explicitly rejected (%s)',
  async deniedScope => {
    get.mockImplementation((url: string) =>
      url.includes('/my-permission')
        ? Promise.reject(new Error('offline'))
        : Promise.reject(
            new ApiError('forbidden', 403, 'CITATION_ACCESS_DENIED', { denied_scope: deniedScope })
          )
    )
    render(<Answer />)
    fireEvent.click(screen.getByTestId('answer-citation-42'))
    if (deniedScope === 'answer') {
      expect(await screen.findByRole('alert')).toHaveTextContent('answer_denied')
      expect(screen.queryByText(/授权回答/)).not.toBeInTheDocument()
      expect(screen.queryByTestId('answer-citation-43')).not.toBeInTheDocument()
    } else if (deniedScope === 'source') {
      expect(await screen.findByTestId('answer-source-access')).toHaveTextContent('source_denied')
      expect(screen.queryByTestId('answer-evidence-panel')).not.toBeInTheDocument()
      expect(screen.queryByTestId('answer-citation-42')).not.toBeInTheDocument()
      expect(screen.queryByText('受限汇总')).not.toBeInTheDocument()
      expect(screen.getByTestId('answer-citation-43')).toBeInTheDocument()
    } else {
      expect(await screen.findByRole('alert')).toHaveTextContent('read_denied')
      expect(screen.getByTestId('answer-citation-42')).toBeInTheDocument()
      expect(screen.getByTestId('answer-citation-43')).toBeInTheDocument()
      expect(screen.queryByTestId('answer-source-access')).not.toBeInTheDocument()
    }
  }
)

test('a 503 keeps the answer available and retries only the selected citation', async () => {
  get.mockRejectedValueOnce(new ApiError('unavailable', 503)).mockResolvedValueOnce({
    citation_id: '42',
    document_id: 9,
    knowledge_base_id: 7,
    content: '重试恢复片段',
  })
  render(
    <AnswerEvidenceMarkdown source="授权回答[[citation:42]]" theme="light" evidence={evidence} />
  )
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  expect(await screen.findByRole('alert')).toHaveTextContent('read_failed')
  fireEvent.click(screen.getByTestId('answer-evidence-retry-read_failed'))
  expect(await screen.findByText('重试恢复片段')).toBeInTheDocument()
  expect(get).toHaveBeenCalledTimes(2)
})

test('an explicit source rejection clears that source in the other answers of the task', async () => {
  const second: Message = {
    ...message,
    subtaskId: 13,
    content: '${$$}$后续回答[[citation:42]]',
  }
  get.mockImplementation((url: string) => {
    if (url.includes('/my-permission')) return Promise.resolve({ source_access: 'readable' })
    if (url.includes('answer_id=12')) {
      return Promise.resolve({
        citation_id: '42',
        document_id: 9,
        knowledge_base_id: 7,
        content: '旧片段',
      })
    }
    return Promise.reject(
      new ApiError('denied', 403, 'CITATION_ACCESS_DENIED', { denied_scope: 'source' })
    )
  })
  function Conversation() {
    const sourceDecisions = useTaskSourceDecisions(3)
    return (
      <TaskSourceDecisions.Provider value={sourceDecisions}>
        <Answer />
        <Answer msg={second} />
      </TaskSourceDecisions.Provider>
    )
  }

  render(<Conversation />)
  fireEvent.click(screen.getAllByTestId('answer-citation-42')[0])
  await screen.findByText('旧片段')
  fireEvent.click(screen.getAllByTestId('answer-citation-42')[1])
  await waitFor(() => expect(screen.queryByText('旧片段')).not.toBeInTheDocument())
  expect(screen.queryByTestId('answer-evidence-panel')).not.toBeInTheDocument()
  expect(screen.queryByText('受限汇总')).not.toBeInTheDocument()
  expect(screen.getAllByTestId('answer-source-access')).toHaveLength(2)
})

test('rechecks the answer before opening an original after task revocation', async () => {
  get.mockResolvedValueOnce({ content: '原先已授权片段', document_id: 9, knowledge_base_id: 7 })
  get.mockRejectedValueOnce(
    new ApiError('denied', 403, 'CITATION_ACCESS_DENIED', { denied_scope: 'answer' })
  )
  render(
    <AnswerEvidenceMarkdown
      source="原先已授权回答[[citation:42]]"
      theme="light"
      evidence={evidence}
    />
  )
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  await screen.findByText('原先已授权片段')
  fireEvent.click(screen.getByTestId('answer-evidence-open-original'))
  expect(await screen.findByRole('alert')).toHaveTextContent('answer_denied')
  expect(screen.queryByText('原先已授权回答')).not.toBeInTheDocument()
  expect(screen.queryByText('原先已授权片段')).not.toBeInTheDocument()
  expect(get.mock.calls.map(([url]) => url)).toEqual([
    expect.stringContaining('/citations/42'),
    expect.stringContaining('/citations/42'),
  ])
})

test('shared copy and export strip action markers while preserving literal Markdown examples', () => {
  const markdown = [
    '正文[[citation:42]]，且\\[[citation:43]]',
    '',
    '    [[citation:42]]',
    '',
    '`[[citation:42]]` [链接 [[citation:42]]](https://example.com)',
    '',
    '<b>[[citation:42]]</b>',
  ].join('\n')
  expect(stripAnswerEvidenceMarkers(markdown)).toBe(
    markdown.replace('正文[[citation:42]]，且\\[[citation:43]]', '正文，且')
  )
})

test('re-entering a task discards its previous viewer capability response', async () => {
  let resolveOldPermission!: (permission: unknown) => void
  get.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveOldPermission = resolve
      })
  )
  get.mockResolvedValue({ source_access: 'readable' })
  const { rerender } = render(<Answer taskId={3} />)
  rerender(<Answer taskId={4} />)
  rerender(<Answer taskId={3} />)
  await act(async () => resolveOldPermission({ source_access: 'visit-only' }))
  expect(screen.getByTestId('answer-citation-42')).toBeInTheDocument()
  expect(screen.queryByTestId('answer-source-access')).not.toBeInTheDocument()
  expect(get.mock.calls.filter(([url]) => url.includes('/7/my-permission?task_id=3'))).toHaveLength(
    2
  )
})

test('a shared reader keeps the authorized answer when citation membership is denied', async () => {
  get.mockRejectedValueOnce(
    new ApiError('denied', 403, 'CITATION_ACCESS_DENIED', { denied_scope: 'answer' })
  )
  render(
    <AnswerEvidenceMarkdown
      source="授权分享正文[[citation:42]]"
      theme="light"
      evidence={{ ...evidence, shared: true }}
    />
  )
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  expect(await screen.findByRole('alert')).toHaveTextContent('read_denied')
  expect(screen.getByText(/授权分享正文/)).toBeInTheDocument()
})

test('a missing snapshot becomes a non-interactive marker', async () => {
  get.mockRejectedValueOnce(new ApiError('missing', 404, 'CITATION_NOT_FOUND'))
  render(
    <AnswerEvidenceMarkdown source="可读回答[[citation:42]]" theme="light" evidence={evidence} />
  )
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  const unavailable = await screen.findByTestId('answer-evidence-unavailable')
  expect(screen.queryByTestId('answer-citation-42')).not.toBeInTheDocument()
  expect(screen.getByText('可读回答')).toBeInTheDocument()
  fireEvent.click(unavailable)
  expect(get).toHaveBeenCalledTimes(1)
})

test('shares task permission reads without sharing an answer-specific visit decision', async () => {
  get.mockImplementation((url: string) =>
    Promise.resolve({
      source_access: url.includes('/8/my-permission')
        ? 'readable'
        : url.includes('answer_id=13')
          ? 'visit-only'
          : 'denied',
    })
  )

  function Conversation() {
    const sourceDecisions = useTaskSourceDecisions(3)
    return (
      <TaskSourceDecisions.Provider value={sourceDecisions}>
        <Answer />
        <Answer msg={{ ...message, subtaskId: 13 }} />
      </TaskSourceDecisions.Provider>
    )
  }

  render(<Conversation />)
  await waitFor(() =>
    expect(screen.getAllByTestId('answer-source-access').map(notice => notice.textContent)).toEqual(
      ['chat:evidence.source_denied', 'chat:evidence.partial_visit_only']
    )
  )
  const requests = get.mock.calls.map(([url]) => url)
  expect(
    requests.filter(url => url === '/share/KnowledgeBase/7/my-permission?task_id=3')
  ).toHaveLength(1)
  expect(
    requests.filter(url => url === '/share/KnowledgeBase/8/my-permission?task_id=3')
  ).toHaveLength(1)
  expect(requests.filter(url => url.includes('answer_id='))).toEqual([
    '/share/KnowledgeBase/7/my-permission?task_id=3&answer_id=12&citation_id=42',
    '/share/KnowledgeBase/7/my-permission?task_id=3&answer_id=13&citation_id=42',
  ])
})

test.each(['chat', 'workbench'] as const)(
  'keeps a fully visit-only answer without snapshots and removes gray decoration in %s',
  async host => {
    get.mockResolvedValue({ source_access: 'visit-only', task_source_bound: true })
    const noSnapshot: Message = {
      ...message,
      content: '${$$}$授权问答[[evidence-unavailable]]',
      result: {
        retrieval_summary: {
          source_statuses: message.result!.retrieval_summary!.source_statuses!.slice(0, 1),
        },
      },
    }
    const answer = <Answer msg={noSnapshot} />
    render(
      host === 'chat' ? (
        answer
      ) : (
        <WorkspaceSourceAccess.Provider
          value={{ knowledgeBaseId: 7, access: 'visit-only', revision: 1 }}
        >
          {answer}
        </WorkspaceSourceAccess.Provider>
      )
    )

    expect(await screen.findByTestId('answer-source-access')).toHaveTextContent(
      'chat:evidence.visit_only'
    )
    expect(screen.getByText('授权问答')).toBeInTheDocument()
    expect(screen.queryByTestId('answer-evidence-unavailable')).not.toBeInTheDocument()
    expect(get.mock.calls.map(([url]) => url)).toEqual(
      host === 'chat' ? ['/share/KnowledgeBase/7/my-permission?task_id=3'] : []
    )
  }
)

test('mixed and unknown sources keep the existing gray decoration', async () => {
  get.mockImplementation((url: string) =>
    url.includes('/7/my-permission')
      ? Promise.resolve({ source_access: 'visit-only', task_source_bound: true })
      : Promise.reject(new ApiError('temporarily unavailable', 503))
  )
  render(<Answer msg={{ ...message, content: message.content + '[[evidence-unavailable]]' }} />)

  expect(await screen.findByTestId('answer-source-access')).toHaveTextContent('partial_visit_only')
  expect(screen.getByTestId('answer-evidence-unavailable')).toBeInTheDocument()
  expect(screen.getByTestId('answer-citation-43')).toBeInTheDocument()
})

test('retrying a permission failure refreshes only its source', async () => {
  let attempts = 0
  get.mockImplementation((url: string) => {
    if (url.includes('/7/my-permission') && attempts++ === 0) {
      return Promise.reject(new ApiError('temporarily unavailable', 503))
    }
    return Promise.resolve({ source_access: 'readable' })
  })
  render(<Answer />)
  const retry = await screen.findByTestId('answer-source-retry-permission')
  expect(screen.queryByTestId('answer-source-access')).not.toBeInTheDocument()
  expect(screen.getByTestId('answer-citation-42')).toBeInTheDocument()
  fireEvent.click(retry)
  await waitFor(() => expect(retry).not.toBeInTheDocument())
  const requests = get.mock.calls.map(([url]) => url)
  expect(requests.filter(url => url.includes('/7/my-permission'))).toHaveLength(2)
  expect(requests.filter(url => url.includes('/8/my-permission'))).toHaveLength(1)
})

test('historical text with no rendered evidence or source hits does not look up permissions', () => {
  render(
    <Answer
      msg={{
        ...message,
        content: '${$$}$历史正文 `[[citation:42]]`',
        result: {
          answer_citations: message.result!.answer_citations,
          retrieval_summary: {
            source_statuses: [
              { ...message.result!.retrieval_summary!.source_statuses![0], status: 'no_hit' },
            ],
          },
        },
      }}
    />
  )
  expect(screen.getByText(/历史正文/)).toBeInTheDocument()
  expect(get).not.toHaveBeenCalled()
})

test('recovery from a shared permission failure clears both answers without duplicate requests', async () => {
  let sourceReads = 0
  get.mockImplementation((url: string) => {
    if (url.includes('/7/my-permission') && sourceReads++ === 0) {
      return Promise.reject(new ApiError('offline', 503))
    }
    return Promise.resolve({ source_access: 'readable' })
  })
  function Conversation() {
    const sourceDecisions = useTaskSourceDecisions(3)
    return (
      <TaskSourceDecisions.Provider value={sourceDecisions}>
        <Answer />
        <Answer msg={{ ...message, subtaskId: 13 }} />
      </TaskSourceDecisions.Provider>
    )
  }

  render(<Conversation />)
  const retries = await screen.findAllByTestId('answer-source-retry-permission')
  expect(retries).toHaveLength(2)
  fireEvent.click(retries[0])
  await waitFor(() =>
    expect(screen.queryAllByTestId('answer-source-retry-permission')).toHaveLength(0)
  )
  expect(sourceReads).toBe(2)
})

test('external-only workbench answers do not inherit the selected library restriction', () => {
  const externalAnswer: Message = {
    ...message,
    content: '${$$}$外部问答[[evidence-unavailable]]',
    result: {
      retrieval_summary: {
        source_statuses: [
          {
            provider: 'external',
            source_id: 'external',
            status: 'hit',
            record_count: 1,
            citation_count: 1,
          },
        ],
      },
    },
  }
  render(
    <WorkspaceSourceAccess.Provider
      value={{ knowledgeBaseId: 7, access: 'visit-only', revision: 1 }}
    >
      <Answer msg={externalAnswer} />
    </WorkspaceSourceAccess.Provider>
  )
  expect(screen.queryByTestId('answer-source-access')).not.toBeInTheDocument()
  expect(screen.getByTestId('answer-evidence-unavailable')).toBeInTheDocument()
  expect(get).not.toHaveBeenCalled()
})
