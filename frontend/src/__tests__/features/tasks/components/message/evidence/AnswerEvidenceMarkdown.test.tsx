import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import AnswerEvidenceMarkdown from '@/features/tasks/components/message/evidence/AnswerEvidenceMarkdown'
import { apiClient } from '@/apis/client'

jest.mock('@/features/common/UserContext', () => ({ useUser: () => ({ user: { id: 1 } }) }))

jest.mock('@/apis/client', () => ({ apiClient: { get: jest.fn(), getCacheScope: () => 'user:1' } }))
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

beforeEach(() => get.mockReset())

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
