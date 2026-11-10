import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AnswerEvidenceMarkdown from '@/features/tasks/components/message/evidence/AnswerEvidenceMarkdown'
import { apiClient } from '@/apis/client'

let currentUser = 1
let currentBackend = 'user:1'
jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: currentUser } }),
}))

jest.mock('@/apis/client', () => ({
  apiClient: { get: jest.fn(), getCacheScope: () => currentBackend },
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
    .mockResolvedValueOnce({ id: 9, kind_id: 7, name: '当前资料' })
    .mockResolvedValueOnce({ original_download_allowed: false })
  render(<AnswerEvidenceMarkdown source="[[citation:42]]" theme="light" evidence={evidence} />)
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  await screen.findByText('快照正文')
  fireEvent.click(screen.getByTestId('answer-evidence-open-original'))
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      '/knowledge-bases/7/document-protection?preview_watermark=true'
    )
  )
  expect(get).toHaveBeenCalledWith('/knowledge-documents/9', { signal: undefined })
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

test.each(['account', 'backend', 'generation', 'answer'] as const)(
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
    .mockRejectedValueOnce(new Error('original unavailable'))
    .mockResolvedValueOnce({ original_download_allowed: false })
  render(<AnswerEvidenceMarkdown source="[[citation:42]]" theme="light" evidence={evidence} />)
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  await screen.findByText('可核验快照')
  fireEvent.click(screen.getByTestId('answer-evidence-open-original'))
  expect(await screen.findByRole('alert')).toHaveTextContent('evidence.original_failed')
  expect(screen.getByText('可核验快照')).toBeInTheDocument()
})
