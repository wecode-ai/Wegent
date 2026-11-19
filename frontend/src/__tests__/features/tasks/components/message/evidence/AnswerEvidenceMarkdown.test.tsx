import userEvent from '@testing-library/user-event'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { ChatEvidenceHost } from '@/features/tasks/components/message/evidence/ChatEvidenceHost'
import AnswerEvidenceMarkdown from '@/features/tasks/components/message/evidence/AnswerEvidenceMarkdown'
import { apiClient, ApiError } from '@/apis/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import MessageBubble, { type Message } from '@/features/tasks/components/message/MessageBubble'
import {
  TaskSourceDecisions,
  useTaskSourceDecisions,
} from '@/features/tasks/components/message/evidence/sourceAccess'
import { filterAnswerEvidenceMarkers } from '@/features/tasks/utils/answerEvidenceMarkers'

let currentUser = 1
let currentBackend = 'user:1'
jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: currentUser } }),
}))

jest.mock('@/apis/client', () => {
  const client = { get: jest.fn(), getCacheScope: () => currentBackend }
  return {
    __esModule: true,
    apiClient: client,
    default: client,
    get ApiError() {
      return jest.requireActual('@/apis/client').ApiError
    },
  }
})
jest.mock('@/hooks/useTraceAction', () => ({
  useTraceAction: () => ({ trace: { event: jest.fn(), copy: jest.fn(), download: jest.fn() } }),
}))
jest.mock('@/hooks/useMessageFeedback', () => ({
  useMessageFeedback: () => ({ feedback: null, handleLike: jest.fn(), handleDislike: jest.fn() }),
}))
jest.mock('@/hooks/useTranslation', () => {
  const t = (
    key: string,
    values?: { title?: string; number?: number; documents?: number; fragments?: number }
  ) => {
    if (key === 'evidence.citation_label') return values?.title + ' · ' + values?.number
    if (key === 'evidence.summary') return values?.documents + '/' + values?.fragments
    return key
  }
  return { useTranslation: () => ({ t }) }
})
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

test.each(['account', 'backend', 'generation', 'answer', 'task'] as const)(
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
    .mockResolvedValueOnce({
      citation_id: '42',
      content: '可核验快照',
      document_id: 9,
      knowledge_base_id: 7,
    })
    .mockResolvedValueOnce({
      citation_id: '42',
      content: '可核验快照',
      document_id: 9,
      knowledge_base_id: 7,
    })
    .mockRejectedValueOnce(new Error('original unavailable'))
    .mockResolvedValueOnce({ original_download_allowed: false })
  render(<AnswerEvidenceMarkdown source="[[citation:42]]" theme="light" evidence={evidence} />)
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  await screen.findByText('可核验快照')
  fireEvent.click(screen.getByTestId('answer-evidence-open-original'))
  expect(await screen.findByRole('alert')).toHaveTextContent('evidence.original_failed')
  fireEvent.click(screen.getByTestId('answer-evidence-return-fragment'))
  expect(screen.getByText('可核验快照')).toBeInTheDocument()
})

test.each(['readable', 'denied', 'unknown'] as const)(
  'an original 403 only hides a source after the current permission is confirmed (%s)',
  async access => {
    const fragment = {
      citation_id: '42',
      content: '证据片段',
      document_id: 9,
      knowledge_base_id: 7,
    }
    get
      .mockResolvedValueOnce(fragment)
      .mockResolvedValueOnce(fragment)
      .mockRejectedValueOnce(new ApiError('original denied', 403))
    if (access === 'unknown') get.mockRejectedValueOnce(new ApiError('offline', 503))
    else get.mockResolvedValueOnce({ source_access: access })
    render(
      <AnswerEvidenceMarkdown
        source="正文[[citation:42]] [[citation:43]]"
        theme="light"
        evidence={{
          ...evidence,
          taskId: 3,
          citations: [...evidence.citations, { ...evidence.citations[0], citation_id: '43' }],
        }}
      />
    )
    fireEvent.click(screen.getByTestId('answer-citation-42'))
    await screen.findByText('证据片段')
    fireEvent.click(screen.getByTestId('answer-evidence-open-original'))
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        '/share/KnowledgeBase/7/my-permission?task_id=3',
        expect.anything()
      )
    )

    if (access === 'denied') {
      await waitFor(() => expect(screen.queryByText('证据片段')).not.toBeInTheDocument())
      expect(screen.queryByTestId('answer-citation-43')).not.toBeInTheDocument()
    } else {
      expect(await screen.findByRole('alert')).toHaveTextContent('evidence.original_denied')
      fireEvent.click(screen.getByTestId('answer-evidence-return-fragment'))
      expect(screen.getByText('证据片段')).toBeInTheDocument()
      expect(screen.getByTestId('answer-citation-43')).toBeInTheDocument()
    }
  }
)

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

function Answer({
  msg = message,
  taskId = 3,
  onSaveToKnowledge,
}: {
  msg?: Message
  taskId?: number
  onSaveToKnowledge?: (content: string) => void
}) {
  return (
    <TooltipProvider>
      <MessageBubble
        msg={msg}
        index={0}
        currentTaskId={taskId}
        selectedTaskDetail={null}
        theme="light"
        t={key => key}
        onSaveToKnowledge={onSaveToKnowledge}
      />
    </TooltipProvider>
  )
}

test('streaming text hides split evidence markers and preserves literal Markdown', () => {
  const marker = '[[evidence:0123456789abcdef0123456789abcdef]]'
  const { rerender, container } = render(<ChatEvidenceHost>{null}</ChatEvidenceHost>)

  for (const withBlocks of [false, true]) {
    for (const length of [1, 2, 5, 11, marker.length - 1, marker.length]) {
      const source = '流式正文 `[[evidence:literal]]` 补充' + marker.slice(0, length)
      rerender(
        <ChatEvidenceHost>
          <Answer
            msg={{
              ...message,
              status: 'streaming',
              subtaskStatus: 'RUNNING',
              content: source,
              result: withBlocks
                ? { blocks: [{ id: 'draft', type: 'text', content: source, status: 'streaming' }] }
                : undefined,
            }}
          />
        </ChatEvidenceHost>
      )
      expect(container.querySelector('.markdown-content p')?.textContent).toBe(
        '流式正文 [[evidence:literal]] 补充'
      )
      expect(screen.getByText('[[evidence:literal]]', { selector: 'code' })).toBeInTheDocument()
      expect(screen.queryByTestId('answer-evidence-unavailable')).not.toBeInTheDocument()
      expect(screen.queryByTestId('answer-citation-42')).not.toBeInTheDocument()
    }
  }

  const saved = '正式正文[[evidence-unavailable]]'
  rerender(
    <ChatEvidenceHost>
      <Answer
        msg={{
          ...message,
          content: saved,
          result: {
            ...message.result,
            answer_citations: [],
            sources: [],
            retrieval_summary: undefined,
            blocks: [{ id: 'saved', type: 'text', content: saved, status: 'done' }],
          },
        }}
      />
    </ChatEvidenceHost>
  )
  expect(screen.getByText('正式正文')).toBeInTheDocument()
  expect(screen.getByTestId('answer-evidence-unavailable')).toBeInTheDocument()
  expect(get).not.toHaveBeenCalled()
})

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

test('saving a mixed answer uses the same citation visibility as its copy text', async () => {
  get.mockImplementation((url: string) =>
    Promise.resolve({
      source_access: url.includes('/7/my-permission') ? 'visit-only' : 'readable',
    })
  )
  const save = jest.fn()
  render(<Answer onSaveToKnowledge={save} />)
  await screen.findByTestId('answer-source-access')
  fireEvent.click(screen.getByTestId('message-save-to-knowledge-button'))
  expect(save).toHaveBeenCalledWith('授权回答，另有说明[[citation:43]]。')
})

test('a source permission change clears the original and discards late reads before recovery', async () => {
  let resolveDocument!: (document: unknown) => void
  get.mockImplementation((url: string) => {
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
    <AnswerEvidenceMarkdown
      source="授权回答[[citation:42]]"
      theme="light"
      evidence={{ ...evidence, sourceAccess: { 7: access } }}
    />
  )
  const { rerender } = render(view('readable'))
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  await screen.findByText('先前片段')
  fireEvent.click(screen.getByTestId('answer-evidence-open-original'))
  await waitFor(() => expect(resolveDocument).toBeDefined())
  rerender(view('visit-only'))
  expect(screen.queryByText('先前片段')).not.toBeInTheDocument()
  expect(screen.queryByTestId('answer-evidence-panel')).not.toBeInTheDocument()
  await act(async () => resolveDocument({ kind_id: 7, id: 9 }))
  expect(screen.queryByTestId('answer-evidence-return-fragment')).not.toBeInTheDocument()
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

test('copy and export preserve readable markers and literal Markdown examples', () => {
  const markdown = [
    '正文[[citation:42]]，且\\[[citation:43]]',
    '',
    '    [[citation:42]]',
    '',
    '`[[citation:42]]` [链接 [[citation:42]]](https://example.com)',
    '',
    '<b>[[citation:42]]</b>',
  ].join('\n')
  const citations = [
    ...evidence.citations,
    { citation_id: '43', title: '其他资料', knowledge_base_id: 8, document_id: 10 },
  ]
  expect(
    filterAnswerEvidenceMarkers(markdown, {
      citations,
      sourceAccess: { 7: 'denied', 8: 'readable' },
    })
  ).toBe(markdown.replace('正文[[citation:42]]', '正文'))
  expect(
    filterAnswerEvidenceMarkers(markdown, {
      citations,
      sourceAccess: { 7: 'readable', 8: 'readable' },
    })
  ).toBe(markdown)
  expect(filterAnswerEvidenceMarkers(markdown, { visitOnly: true })).toBe(
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

test('shares current task permission reads across answers without a snapshot-based lookup', async () => {
  get.mockImplementation((url: string) =>
    Promise.resolve({
      source_access: url.includes('/8/my-permission') ? 'readable' : 'denied',
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
      ['chat:evidence.source_denied', 'chat:evidence.source_denied']
    )
  )
  const requests = get.mock.calls.map(([url]) => url)
  expect(
    requests.filter(url => url === '/share/KnowledgeBase/7/my-permission?task_id=3')
  ).toHaveLength(1)
  expect(
    requests.filter(url => url === '/share/KnowledgeBase/8/my-permission?task_id=3')
  ).toHaveLength(1)
  expect(requests).toHaveLength(2)
})

test('keeps a fully visit-only answer without snapshots and removes gray decoration', async () => {
  get.mockResolvedValue({ source_access: 'visit-only' })
  const noSnapshot: Message = {
    ...message,
    content: '${$$}$授权问答[[evidence-unavailable]]',
    result: {
      retrieval_summary: {
        source_statuses: message.result!.retrieval_summary!.source_statuses!.slice(0, 1),
      },
    },
  }
  render(<Answer msg={noSnapshot} />)

  expect(await screen.findByTestId('answer-source-access')).toHaveTextContent(
    'chat:evidence.visit_only'
  )
  expect(screen.getByText('授权问答')).toBeInTheDocument()
  expect(screen.queryByTestId('answer-evidence-unavailable')).not.toBeInTheDocument()
  expect(get.mock.calls.map(([url]) => url)).toEqual([
    '/share/KnowledgeBase/7/my-permission?task_id=3',
  ])
})

test('mixed and unknown sources keep the existing gray decoration', async () => {
  get.mockImplementation((url: string) =>
    url.includes('/7/my-permission')
      ? Promise.resolve({ source_access: 'visit-only' })
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

test('external-only answers keep their existing gray decoration without a permission lookup', () => {
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
  render(<Answer msg={externalAnswer} />)
  expect(screen.queryByTestId('answer-source-access')).not.toBeInTheDocument()
  expect(screen.getByTestId('answer-evidence-unavailable')).toBeInTheDocument()
  expect(get).not.toHaveBeenCalled()
})

test('chat numbers citations by the rendered blocks and keeps one panel when switching excerpts', async () => {
  get.mockImplementation(async (url: string) => {
    if (url.includes('my-permission')) return { source_access: 'readable' }
    const citationId = url.includes('/43?') ? '43' : '42'
    return {
      citation_id: citationId,
      knowledge_base_id: 7,
      document_id: 9,
      content: '片段 ' + citationId,
    }
  })
  const blocks: NonNullable<NonNullable<Message['result']>['blocks']> = [
    { id: 'a', type: 'text', content: '`[[citation:42]]` 正文[[citation:43]]' },
    { id: 'b', type: 'text', content: '后续[[citation:42]]和[[citation:43]]' },
  ]
  render(
    <ChatEvidenceHost>
      <Answer
        msg={{
          ...message,
          result: {
            ...message.result,
            sources: [],
            blocks,
            answer_citations: [
              ...evidence.citations,
              { ...evidence.citations[0], citation_id: '43' },
            ],
          },
        }}
      />
    </ChatEvidenceHost>
  )
  const [first, repeated] = screen.getAllByTestId('answer-citation-43')
  const second = screen.getByTestId('answer-citation-42')
  expect(first).toHaveAccessibleName('资料 · 1')
  expect(repeated).toHaveAccessibleName('资料 · 1')
  expect(second).toHaveAccessibleName('资料 · 2')
  expect(screen.getByTestId('answer-evidence-summary')).toHaveTextContent('1/2')
  fireEvent.click(first)
  expect(await screen.findByTestId('answer-evidence-content')).toHaveTextContent('片段 43')
  await userEvent.selectOptions(screen.getByTestId('answer-evidence-select-fragment'), '42')
  expect(screen.queryByText('片段 43')).not.toBeInTheDocument()
  expect(await screen.findByTestId('answer-evidence-content')).toHaveTextContent('片段 42')
  expect(screen.getAllByTestId('answer-evidence-panel')).toHaveLength(1)
  fireEvent.click(screen.getByTestId('answer-evidence-close'))
  await waitFor(() => expect(first).toHaveFocus())
  expect(screen.queryByTestId('answer-evidence-preview')).not.toBeInTheDocument()
})

test('keyboard preview and panel independently authorize the same citation', async () => {
  const snapshot = { citation_id: '42', knowledge_base_id: 7, document_id: 9 }
  let reads = 0
  get.mockImplementation(async (url: string) => {
    if (url.includes('my-permission')) return { source_access: 'readable' }
    return { ...snapshot, content: ++reads === 1 ? '预览正文' : '深入核验正文' }
  })
  render(
    <ChatEvidenceHost>
      <Answer />
    </ChatEvidenceHost>
  )
  const citation = screen.getByTestId('answer-citation-42')
  await act(async () => citation.focus())
  expect(await screen.findByTestId('answer-evidence-preview-content')).toHaveTextContent('预览正文')
  expect(reads).toBe(1)
  await userEvent.keyboard('{Enter}')
  expect(screen.queryByText('预览正文')).not.toBeInTheDocument()
  expect(await screen.findByTestId('answer-evidence-content')).toHaveTextContent('深入核验正文')
  expect(reads).toBe(2)
  fireEvent.keyDown(screen.getByTestId('answer-evidence-close'), { key: 'Escape' })
  await waitFor(() => expect(citation).toHaveFocus())
  expect(screen.queryByTestId('answer-evidence-preview')).not.toBeInTheDocument()
  expect(reads).toBe(2)
  fireEvent.click(citation)
  await waitFor(() => expect(reads).toBe(3))
  expect(
    get.mock.calls
      .filter(([url]) => url.includes('/citations/'))
      .map(([, options]) => options.cache)
  ).toEqual(['no-store', 'no-store', 'no-store'])
})

function snapshotOf(citationId: string, content = '回答时的快照') {
  const citation = message.result?.answer_citations?.find(item => item.citation_id === citationId)
  return { ...citation, content }
}

const citationReads = () => get.mock.calls.filter(([url]) => url.includes('/citations/'))
const isEvidenceMetadataRead = (url: string) => /\/citations\/|\/my-permission/.test(url)

test('hover stays open when the pointer crosses into the preview, then closes', async () => {
  get.mockImplementation(async (url: string) =>
    url.includes('my-permission') ? { source_access: 'readable' } : snapshotOf('42')
  )
  const user = userEvent.setup()
  render(
    <ChatEvidenceHost>
      <Answer />
    </ChatEvidenceHost>
  )
  await user.hover(screen.getByTestId('answer-citation-42'))
  expect(citationReads()).toHaveLength(0)
  const preview = await screen.findByTestId('answer-evidence-preview')
  await user.hover(preview)
  expect(within(preview).getByTestId('answer-evidence-preview-content')).toHaveClass('line-clamp-4')
  expect(citationReads()).toHaveLength(1)
  expect(get.mock.calls.every(([url]) => isEvidenceMetadataRead(url))).toBe(true)
  await user.unhover(preview)
  await waitFor(() => expect(preview).not.toBeInTheDocument())
})

test.each([
  [1100, false, 'side', 'complementary'],
  [800, false, 'overlay', 'dialog'],
  [390, true, 'mobile', 'dialog'],
])('chat width %i shows the %s mobile variant as %s', async (width, mobile, layout, role) => {
  const measuredWidth = jest
    .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
    .mockReturnValue(width)
  try {
    get.mockImplementation(async (url: string) =>
      url.includes('my-permission') ? { source_access: 'readable' } : snapshotOf('42')
    )
    const user = userEvent.setup()
    render(
      <ChatEvidenceHost mobile={mobile}>
        <Answer />
      </ChatEvidenceHost>
    )
    const trigger = screen.getByTestId('answer-citation-42')
    if (mobile) {
      await user.pointer([{ keys: '[TouchA>]', target: trigger }, '[/TouchA]'])
    } else {
      await user.click(trigger)
    }
    const panel = await screen.findByRole(role)
    expect(panel).toHaveAttribute('data-layout', layout)
    expect(panel).toHaveAttribute('data-version-status', 'unknown')
    expect(panel.closest('[data-task-right-panel]') !== null).toBe(layout === 'side')
    expect(await within(panel).findByTestId('answer-evidence-content')).toHaveTextContent(
      '回答时的快照'
    )
    expect(within(panel).queryByTestId('answer-evidence-open-original')).toBeInTheDocument()
    expect(citationReads()).toHaveLength(1)
    expect(get.mock.calls.every(([url]) => isEvidenceMetadataRead(url))).toBe(true)
    expect(within(panel).getByTestId('answer-evidence-close')).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(screen.queryByTestId('answer-evidence-panel')).not.toBeInTheDocument()
  } finally {
    measuredWidth.mockRestore()
  }
})

test('chat summary shows only actual permitted snapshots and preserves external references', async () => {
  get.mockImplementation(async (url: string) => {
    if (url.includes('/7/my-permission')) return { source_access: 'visit-only' }
    if (url.includes('/8/my-permission'))
      return { source_access: 'readable', original_download_allowed: false }
    return snapshotOf('43')
  })
  render(
    <ChatEvidenceHost>
      <Answer
        msg={{
          ...message,
          result: {
            ...message.result,
            sources: [
              ...(message.result?.sources ?? []),
              {
                index: 3,
                title: '外部参考',
                source_type: 'external',
                source_uri: 'https://example.test',
              },
            ],
          },
        }}
      />
    </ChatEvidenceHost>
  )
  expect(await screen.findByTestId('answer-source-access')).toHaveTextContent('partial_visit_only')
  expect(screen.queryByTestId('answer-citation-42')).not.toBeInTheDocument()
  expect(screen.getByTestId('answer-citation-43')).toHaveAccessibleName('可读引用 · 2')
  expect(screen.getByTestId('answer-evidence-summary')).toHaveTextContent('1/1')
  expect(screen.queryByText('受限汇总')).not.toBeInTheDocument()
  expect(screen.queryByText('可读汇总')).not.toBeInTheDocument()
  expect(screen.getByText('外部参考').closest('a')).toHaveAttribute('href', 'https://example.test')
  expect(citationReads()).toHaveLength(0)
  fireEvent.click(screen.getByTestId('answer-citation-43'))
  expect(await screen.findByTestId('answer-evidence-content')).toBeInTheDocument()
})

test.each(['account', 'backend', 'task', 'answer', 'generation', 'citation', 'close'] as const)(
  'ordinary chat discards a late snapshot after %s changes',
  async change => {
    let deliver!: (value: unknown) => void
    get.mockImplementation((url: string) =>
      url.includes('my-permission')
        ? Promise.resolve({ source_access: 'readable' })
        : new Promise(resolve => {
            deliver = resolve
          })
    )
    const view = (msg = message, taskId = 3) => (
      <ChatEvidenceHost>
        <Answer msg={msg} taskId={taskId} />
      </ChatEvidenceHost>
    )
    const { rerender } = render(view())
    await act(async () => fireEvent.click(screen.getByTestId('answer-citation-42')))
    expect(await screen.findByTestId('answer-evidence-panel')).toBeInTheDocument()
    const signal = citationReads()[0][1].signal as AbortSignal

    if (change === 'account') currentUser = 2
    if (change === 'backend') currentBackend = 'backend:2'
    if (change === 'close') fireEvent.click(screen.getByTestId('answer-evidence-close'))
    else
      rerender(
        view(
          {
            ...message,
            subtaskId: change === 'answer' ? 100 : message.subtaskId,
            result: {
              ...message.result,
              answer_generation_id:
                change === 'generation' ? 'b'.repeat(32) : evidence.generationId,
              answer_citations:
                change === 'citation'
                  ? message.result?.answer_citations?.filter(item => item.citation_id !== '42')
                  : message.result?.answer_citations,
            },
          },
          change === 'task' ? 4 : 3
        )
      )

    expect(signal.aborted).toBe(true)
    expect(screen.queryByTestId('answer-evidence-panel')).not.toBeInTheDocument()
    await act(async () => deliver(snapshotOf('42', '迟到正文')))
    expect(screen.queryByText('迟到正文')).not.toBeInTheDocument()
    expect(screen.queryByTestId('answer-evidence-preview')).not.toBeInTheDocument()
  }
)

test.each([
  [403, 'read_denied', false],
  [404, 'unavailable', false],
  [409, 'unavailable', false],
  [503, 'read_failed', true],
  [undefined, 'read_failed', true],
])(
  'chat handles snapshot failure %s and retries only recoverable reads',
  async (status, key, recoverable) => {
    let reads = 0
    get.mockImplementation(async (url: string) => {
      if (url.includes('my-permission')) return { source_access: 'readable' }
      reads++
      if (reads === 2)
        throw status ? new ApiError('snapshot failure', status) : new TypeError('offline')
      return snapshotOf('42', reads === 1 ? '旧授权正文' : '重试后的快照')
    })
    render(
      <ChatEvidenceHost>
        <Answer />
      </ChatEvidenceHost>
    )
    const trigger = screen.getByTestId('answer-citation-42')
    fireEvent.click(trigger)
    expect(await screen.findByText('旧授权正文')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('answer-evidence-close'))
    fireEvent.click(trigger)
    expect(
      await within(screen.getByTestId('answer-evidence-panel')).findByRole('alert')
    ).toHaveTextContent(`evidence.${key}`)
    expect(screen.queryByText('旧授权正文')).not.toBeInTheDocument()
    const retry = screen.queryByTestId('answer-evidence-retry-read_failed')
    if (recoverable && retry) {
      fireEvent.click(retry)
      expect(await screen.findByText('重试后的快照')).toBeInTheDocument()
    } else {
      expect(retry).not.toBeInTheDocument()
    }
    expect(citationReads()).toHaveLength(recoverable ? 3 : 2)
  }
)

test('a source permission decision clears an open snapshot and hides its entries only', async () => {
  let permission!: (value: unknown) => void
  get.mockImplementation((url: string) => {
    if (url.includes('/7/my-permission'))
      return new Promise(resolve => {
        permission = resolve
      })
    if (url.includes('/8/my-permission')) return Promise.resolve({ source_access: 'readable' })
    return Promise.resolve(snapshotOf('42', '待核验片段'))
  })
  render(
    <ChatEvidenceHost>
      <Answer />
    </ChatEvidenceHost>
  )
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  expect(await screen.findByText('待核验片段')).toBeInTheDocument()
  await act(async () => permission({ source_access: 'visit-only' }))
  expect(screen.queryByText('待核验片段')).not.toBeInTheDocument()
  expect(screen.queryByTestId('answer-evidence-panel')).not.toBeInTheDocument()
  expect(screen.getByText(/授权回答/).closest('[data-message-content]')).toHaveFocus()
  expect(screen.queryByTestId('answer-citation-42')).not.toBeInTheDocument()
  expect(screen.queryByTestId('answer-evidence-summary-citation-42')).not.toBeInTheDocument()
  expect(screen.getByTestId('answer-citation-43')).toHaveAccessibleName('可读引用 · 2')
  expect(screen.getByTestId('answer-evidence-summary')).toHaveTextContent('1/1')
  expect(citationReads()).toHaveLength(1)
})

test('a selected citation from a second answer supersedes the first answer panel', async () => {
  let deliver!: (value: unknown) => void
  const width = jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1100)
  try {
    get.mockImplementation((url: string) => {
      if (url.includes('my-permission')) return Promise.resolve({ source_access: 'readable' })
      if (url.includes('answer_id=13')) return Promise.resolve(snapshotOf('42', '第二条回答片段'))
      return new Promise(resolve => {
        deliver = resolve
      })
    })
    render(
      <ChatEvidenceHost>
        <Answer />
        <Answer msg={{ ...message, subtaskId: 13 }} />
      </ChatEvidenceHost>
    )
    const [first, second] = screen.getAllByTestId('answer-citation-42')
    fireEvent.click(first)
    fireEvent.click(second)
    await act(async () => deliver(snapshotOf('42', '迟到的第一条回答片段')))
    expect(await screen.findByText('第二条回答片段')).toBeInTheDocument()
    expect(screen.queryByText('迟到的第一条回答片段')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('answer-evidence-panel')).toHaveLength(1)
    expect((citationReads()[0][1].signal as AbortSignal).aborted).toBe(true)
  } finally {
    width.mockRestore()
  }
})

test('ordinary chat ignores markers inside raw HTML with quoted attributes', async () => {
  get.mockResolvedValue({ source_access: 'readable' })
  const raw =
    '前置 <a href="https://example.test?q=>">[[citation:42]]</b>[[citation:42]]</a> 后续[[citation:43]]'
  render(
    <ChatEvidenceHost>
      <Answer msg={{ ...message, content: raw }} />
    </ChatEvidenceHost>
  )
  expect(screen.queryByTestId('answer-citation-42')).not.toBeInTheDocument()
  expect(screen.getByTestId('answer-citation-43')).toHaveAccessibleName('可读引用 · 1')
  expect(screen.getByTestId('answer-evidence-summary')).toHaveTextContent('1/1')
  await act(async () => {})
  expect(citationReads()).toHaveLength(0)
})

test('dismissing a mouse preview keeps focus in the chat input', async () => {
  get.mockImplementation(async (url: string) =>
    url.includes('my-permission') ? { source_access: 'readable' } : snapshotOf('42')
  )
  const user = userEvent.setup()
  render(
    <ChatEvidenceHost>
      <Answer />
      <input aria-label="聊天输入框" />
    </ChatEvidenceHost>
  )
  const input = screen.getByRole('textbox', { name: '聊天输入框' })
  await user.click(input)
  await user.hover(screen.getByTestId('answer-citation-42'))
  expect(await screen.findByTestId('answer-evidence-preview')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(input).toHaveFocus()
  expect(screen.queryByTestId('answer-evidence-preview')).not.toBeInTheDocument()
})

test('source permission checks follow the Markdown that is actually displayed', async () => {
  get.mockResolvedValue({ source_access: 'visit-only' })
  render(
    <ChatEvidenceHost>
      <Answer
        msg={{
          ...message,
          content: '$$\n普通文字[[citation:42]]',
          result: {
            answer_generation_id: evidence.generationId,
            answer_citations: evidence.citations,
          },
        }}
      />
    </ChatEvidenceHost>
  )
  expect(await screen.findByTestId('answer-source-access')).toHaveTextContent('visit_only')
  expect(screen.getByText(/普通文字/)).toBeInTheDocument()
  expect(screen.queryByTestId('answer-citation-42')).not.toBeInTheDocument()
  expect(screen.queryByTestId('answer-evidence-summary')).not.toBeInTheDocument()
  expect(citationReads()).toHaveLength(0)
})

test('the chat host temporarily yields an occupied right panel without losing its state', async () => {
  get.mockImplementation(async (url: string) =>
    url.includes('my-permission') ? { source_access: 'readable' } : snapshotOf('42')
  )
  const otherPanel = { panelType: 'chat-workspace', panelProps: {} }
  function ChatWithRightPanel() {
    const [evidenceOpen, setEvidenceOpen] = useState(false)
    return (
      <>
        <ChatEvidenceHost otherPanelRequest={otherPanel} onPanelChange={setEvidenceOpen}>
          <Answer />
        </ChatEvidenceHost>
        <aside hidden={evidenceOpen}>
          <input aria-label="右栏草稿" />
        </aside>
      </>
    )
  }
  const user = userEvent.setup()
  render(<ChatWithRightPanel />)
  const draft = screen.getByRole('textbox', { name: '右栏草稿' })
  await user.type(draft, '草稿')
  await user.click(screen.getByTestId('answer-citation-42'))
  expect(await screen.findByTestId('answer-evidence-content')).toBeInTheDocument()
  expect(draft).not.toBeVisible()
  await user.click(screen.getByTestId('answer-evidence-close'))
  expect(draft).toBeVisible()
  expect(draft).toHaveValue('草稿')
})

test('closing the side panel returns focus to the collapsed source summary', async () => {
  const width = jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1100)
  try {
    get.mockImplementation(async (url: string) =>
      url.includes('my-permission') ? { source_access: 'readable' } : snapshotOf('42')
    )
    const user = userEvent.setup()
    render(
      <ChatEvidenceHost>
        <Answer />
      </ChatEvidenceHost>
    )
    const summary = screen.getByTestId('answer-evidence-summary')
    await user.click(summary)
    await user.click(screen.getByTestId('answer-evidence-summary-citation-42'))
    const panel = await screen.findByRole('complementary')
    await user.click(summary)
    expect(summary.parentElement).not.toHaveAttribute('open')
    await user.click(within(panel).getByTestId('answer-evidence-close'))
    expect(summary).toHaveFocus()
    expect(screen.queryByTestId('answer-evidence-preview')).not.toBeInTheDocument()
  } finally {
    width.mockRestore()
  }
})

test.each([
  '<svg><text>[[citation:42]]</text></svg> <svg />',
  '<svg data-id=value/>[[citation:42]]</svg> <svg focusable/>',
  '<a />[[citation:42]]</a> <math/>',
])('raw HTML %s preserves citations that follow it', async raw => {
  get.mockResolvedValue({ source_access: 'readable' })
  await act(async () => {
    render(
      <ChatEvidenceHost>
        <Answer msg={{ ...message, content: `前置 ${raw} 后续[[citation:43]]` }} />
      </ChatEvidenceHost>
    )
  })
  expect(screen.queryByTestId('answer-citation-42')).not.toBeInTheDocument()
  expect(screen.getByTestId('answer-citation-43')).toHaveAccessibleName('可读引用 · 1')
  expect(screen.getByTestId('answer-evidence-summary')).toHaveTextContent('1/1')
  expect(citationReads()).toHaveLength(0)
})

test.each(['loading', 'ready'] as const)(
  'clears a %s desktop preview on mobile without closing a panel',
  async state => {
    let resolvePreview!: (value: ReturnType<typeof snapshotOf>) => void
    let previewSignal: AbortSignal | undefined
    get.mockImplementation((url: string, options) => {
      if (url.includes('my-permission')) return Promise.resolve({ source_access: 'readable' })
      if (!previewSignal) {
        previewSignal = options.signal
        return new Promise(resolve => {
          resolvePreview = resolve
        })
      }
      return Promise.resolve(snapshotOf('42', '核验正文'))
    })

    const view = (mobile: boolean) => (
      <ChatEvidenceHost mobile={mobile}>
        <Answer />
      </ChatEvidenceHost>
    )
    const { rerender } = render(view(false))
    const trigger = screen.getByTestId('answer-citation-42')
    await act(async () => trigger.focus())
    expect(await screen.findByTestId('answer-evidence-preview')).toBeInTheDocument()
    if (state === 'ready') {
      await act(async () => resolvePreview(snapshotOf('42', '悬浮正文')))
      expect(screen.getByText('悬浮正文')).toBeInTheDocument()
    }

    rerender(view(true))
    expect(previewSignal?.aborted).toBe(true)
    expect(screen.queryByTestId('answer-evidence-preview')).not.toBeInTheDocument()
    if (state === 'loading') {
      await act(async () => resolvePreview(snapshotOf('42', '迟到的悬浮正文')))
      expect(screen.queryByText('迟到的悬浮正文')).not.toBeInTheDocument()
    }
    rerender(view(false))
    expect(screen.queryByTestId('answer-evidence-preview')).not.toBeInTheDocument()
    fireEvent.click(trigger)
    expect(await screen.findByTestId('answer-evidence-content')).toHaveTextContent('核验正文')
    rerender(view(true))
    expect(screen.getByTestId('answer-evidence-panel')).toHaveAttribute('data-layout', 'mobile')
    expect(screen.getByTestId('answer-evidence-content')).toHaveTextContent('核验正文')
    expect(citationReads()).toHaveLength(2)
  }
)
