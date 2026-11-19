// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { apiClient, ApiError } from '@/apis/client'
import { getToken } from '@/apis/user'
import { getApiBaseUrl } from '@/lib/runtime-config'
import { TooltipProvider } from '@/components/ui/tooltip'
import MessageBubble, { type Message } from '@/features/tasks/components/message/MessageBubble'
import { ChatEvidenceHost } from '@/features/tasks/components/message/evidence/ChatEvidenceHost'
import { AnswerEvidencePanel } from '@/features/tasks/components/message/evidence/AnswerEvidencePanel'

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
jest.mock('@/apis/user', () => ({
  ...jest.requireActual('@/apis/user'),
  getToken: jest.fn(),
}))
jest.mock('@/lib/runtime-config', () => ({
  ...jest.requireActual('@/lib/runtime-config'),
  getApiBaseUrl: jest.fn(() => '/api'),
}))
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
jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' }),
}))
jest.mock('react-markdown', () =>
  jest.requireActual('../../../../../../../node_modules/react-markdown/index.js')
)
jest.mock('rehype-raw', () =>
  jest.requireActual('../../../../../../../node_modules/rehype-raw/index.js')
)
jest.mock('@/components/common/FilePreview', () => ({
  FilePreview: ({ filename }: { filename: string }) => (
    <div data-testid="file-preview-body">{filename}</div>
  ),
}))
jest.mock('next/navigation', () => {
  const router = { push: jest.fn() }
  return { ...jest.requireActual('next/navigation'), useRouter: () => router }
})

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

function snapshotOf(citationId: string, content = '回答时的快照') {
  const citation = message.result?.answer_citations?.find(item => item.citation_id === citationId)
  return { ...citation, content }
}

const citationReads = () => get.mock.calls.filter(([url]) => url.includes('/citations/'))
const isEvidenceMetadataRead = (url: string) => /\/citations\/|\/my-permission/.test(url)

function mockAttachmentFetch() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  const attachmentFetch = jest.fn()
  Object.defineProperty(globalThis, 'fetch', { value: attachmentFetch, configurable: true })
  return {
    attachmentFetch,
    restoreFetch: () => {
      if (descriptor) Object.defineProperty(globalThis, 'fetch', descriptor)
      else Reflect.deleteProperty(globalThis, 'fetch')
    },
  }
}

const currentDocument = {
  id: 9,
  kind_id: 7,
  name: '现在的知识文档',
  source_type: 'file',
  file_extension: '.pdf',
  attachment_id: 100,
  file_size: 2000,
}

function renderChatEvidence() {
  return render(
    <ChatEvidenceHost>
      <Answer />
    </ChatEvidenceHost>
  )
}

async function openOriginal() {
  fireEvent.click(screen.getByTestId('answer-citation-42'))
  const panel = await screen.findByTestId('answer-evidence-panel')
  const open = await within(panel).findByTestId('answer-evidence-open-original')
  return { panel, open }
}

test('chat requests protected current content on demand, pages explicitly and restores the selected excerpt', async () => {
  const canvas = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    scale: jest.fn(),
    translate: jest.fn(),
    rotate: jest.fn(),
    fillText: jest.fn(),
  } as unknown as CanvasRenderingContext2D)
  const image = jest
    .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    .mockReturnValue('data:image/png;base64,AA==')
  const { attachmentFetch, restoreFetch } = mockAttachmentFetch()
  try {
    get.mockImplementation(async (url: string) => {
      if (url.includes('my-permission')) return { source_access: 'readable' }
      if (url.includes('/citations/42')) return snapshotOf('42')
      if (url === '/knowledge-documents/9') return currentDocument
      if (url.includes('/document-protection'))
        return { original_download_allowed: false, watermark_text: '当前用户的水印' }
      if (url.includes('offset=0'))
        return { document_id: 9, content: '当前正文', content_length: 8, truncated: true }
      if (url.includes('offset=4'))
        return { document_id: 9, content: '分页内容', content_length: 8, truncated: false }
      throw new Error(url)
    })
    renderChatEvidence()
    const { panel, open } = await openOriginal()
    const scroll = within(panel).getByTestId('answer-evidence-scroll')
    scroll.scrollTop = 146
    expect(within(panel).queryByTestId('answer-evidence-copy-fragment')).not.toBeInTheDocument()
    expect(get.mock.calls.every(([url]) => isEvidenceMetadataRead(url))).toBe(true)
    expect(attachmentFetch).not.toHaveBeenCalled()

    fireEvent.click(open)
    expect(await within(panel).findByText('当前正文')).toBeInTheDocument()
    expect(within(panel).getByText('evidence.current_original')).toBeInTheDocument()
    expect(within(panel).queryByText('回答时的快照')).not.toBeInTheDocument()
    expect(within(panel).queryByTestId('knowledge-source-preview')).not.toBeInTheDocument()
    expect(within(panel).getByTestId('knowledge-document-watermark')).toHaveAttribute(
      'data-watermark-text',
      '当前用户的水印'
    )
    expect(attachmentFetch).not.toHaveBeenCalled()
    expect(citationReads()).toHaveLength(2)
    expect(get.mock.calls.map(([url]) => url)).toContain(
      '/knowledge-bases/7/document-protection?preview_watermark=true'
    )
    expect(get.mock.calls.filter(([url]) => url.includes('/detail?'))).toHaveLength(1)
    fireEvent.click(within(panel).getByTestId('load-more-button'))
    expect(await within(panel).findByText('当前正文分页内容')).toBeInTheDocument()

    fireEvent.click(within(panel).getByTestId('answer-evidence-return-fragment'))
    expect(within(panel).getByText('回答时的快照')).toBeInTheDocument()
    expect(within(panel).getByTestId('answer-evidence-select-fragment')).toHaveValue('42')
    expect(within(panel).getByRole('heading', { name: '资料', level: 3 })).toBeInTheDocument()
    expect(within(panel).getByTestId('answer-evidence-scroll').scrollTop).toBe(146)
    expect(within(panel).getByTestId('answer-evidence-open-original')).toHaveFocus()
    expect(citationReads()).toHaveLength(2)
  } finally {
    canvas.mockRestore()
    image.mockRestore()
    restoreFetch()
  }
})

test.each(['moved', 'policy error'] as const)(
  'chat keeps the excerpt and blocks current content after %s',
  async failure => {
    const { attachmentFetch, restoreFetch } = mockAttachmentFetch()
    try {
      get.mockImplementation(async (url: string) => {
        if (url.includes('my-permission')) return { source_access: 'readable' }
        if (url.includes('/citations/42')) return snapshotOf('42')
        if (url === '/knowledge-documents/9')
          return { ...currentDocument, kind_id: failure === 'moved' ? 8 : 7 }
        if (url.includes('/document-protection')) throw new ApiError('policy offline', 503)
        throw new Error(url)
      })
      renderChatEvidence()
      const { panel, open } = await openOriginal()
      fireEvent.click(open)
      expect(await within(panel).findByRole('alert')).toHaveTextContent(
        failure === 'moved' ? 'evidence.original_unavailable' : 'evidence.original_failed'
      )
      expect(attachmentFetch).not.toHaveBeenCalled()
      expect(get.mock.calls.some(([url]) => url.includes('/detail?'))).toBe(false)
      const retry = within(panel).queryByTestId('answer-evidence-retry-original_failed')
      if (failure === 'moved') {
        expect(retry).not.toBeInTheDocument()
        expect(get.mock.calls.some(([url]) => url.includes('/document-protection'))).toBe(false)
      } else {
        expect(retry).toBeInTheDocument()
        get.mockImplementation(async (url: string) => {
          if (url.includes('/citations/42')) return snapshotOf('42')
          if (url === '/knowledge-documents/9')
            return { ...currentDocument, file_extension: '.txt' }
          if (url.includes('/document-protection')) return { original_download_allowed: true }
          if (url.includes('/detail?')) return { document_id: 9, content: '重试成功' }
          throw new Error(url)
        })
        fireEvent.click(retry!)
        expect(await within(panel).findByText('重试成功')).toBeInTheDocument()
      }
      fireEvent.click(within(panel).getByTestId('answer-evidence-return-fragment'))
      expect(within(panel).getByText('回答时的快照')).toBeInTheDocument()
    } finally {
      restoreFetch()
    }
  }
)

test.each([
  'account',
  'backend',
  'task',
  'answer',
  'generation',
  'citation',
  'close',
  'return',
] as const)('chat discards late original metadata after %s changes', async change => {
  let deliver!: (value: unknown) => void
  get.mockImplementation(async (url: string) => {
    if (url.includes('my-permission')) return { source_access: 'readable' }
    if (url.includes('/citations/42')) return snapshotOf('42')
    if (url.includes('/citations/43')) return snapshotOf('43', '下一个引用片段')
    if (url === '/knowledge-documents/9')
      return new Promise(resolve => {
        deliver = resolve
      })
    throw new Error(url)
  })
  const view = (msg = message, taskId = 3) => (
    <ChatEvidenceHost>
      <Answer msg={msg} taskId={taskId} />
    </ChatEvidenceHost>
  )
  const { rerender } = render(view())
  const { panel, open } = await openOriginal()
  fireEvent.click(open)
  await waitFor(() => expect(deliver).toBeDefined())
  const request = get.mock.calls.find(([url]) => url === '/knowledge-documents/9')
  const signal = request?.[1].signal as AbortSignal

  if (change === 'citation') {
    fireEvent.change(within(panel).getByTestId('answer-evidence-select-fragment'), {
      target: { value: '43' },
    })
    expect(await within(panel).findByText('下一个引用片段')).toBeInTheDocument()
  } else if (change === 'return') {
    fireEvent.click(within(panel).getByTestId('answer-evidence-return-fragment'))
    expect(within(panel).getByText('回答时的快照')).toBeInTheDocument()
  } else if (change === 'close') {
    fireEvent.click(within(panel).getByTestId('answer-evidence-close'))
  } else {
    if (change === 'account') currentUser = 2
    if (change === 'backend') currentBackend = 'backend:2'
    rerender(
      view(
        {
          ...message,
          subtaskId: change === 'answer' ? 100 : message.subtaskId,
          result: {
            ...message.result,
            answer_generation_id: change === 'generation' ? 'b'.repeat(32) : evidence.generationId,
          },
        },
        change === 'task' ? 4 : 3
      )
    )
  }

  expect(signal.aborted).toBe(true)
  await act(async () => deliver(currentDocument))
  expect(screen.queryByText(currentDocument.name)).not.toBeInTheDocument()
  expect(get.mock.calls.some(([url]) => url.includes('/document-protection'))).toBe(false)
})

test.each(['same', 'changed', 'unknown'] as const)(
  'renders supplied version facts in the %s panel fixture',
  async versionStatus => {
    const citation = evidence.citations[0]
    const entry = { citation, number: 1 }
    const anchor = document.createElement('button')
    get.mockResolvedValue(snapshotOf('42'))
    render(
      <AnswerEvidencePanel
        embedded
        onClose={() => {}}
        panelProps={{
          read: {
            kind: 'panel',
            scope: 'fixture',
            entry,
            anchor,
            status: 'ready',
            snapshot: {
              ...citation,
              content: '回答时片段',
            },
          },
          entries: [entry],
          mode: 'side',
          versionStatus,
          original: {
            citation,
            evidence,
            selectionSignal: new AbortController().signal,
            onSnapshotRejected: () => {},
            onSourceDenied: () => {},
          },
          restoreFocus: () => {},
          onSelect: () => {},
          onRetry: () => {},
        }}
      />
    )
    expect(screen.getByText('回答时片段')).toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
    if (versionStatus === 'changed') {
      expect(screen.getByText('evidence.original_changed')).toBeInTheDocument()
      expect(screen.getByTestId('answer-evidence-return-fragment')).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      fireEvent.click(screen.getByTestId('answer-evidence-open-original'))
      expect(screen.getByTestId('answer-evidence-open-original')).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      fireEvent.click(screen.getByTestId('answer-evidence-return-fragment'))
      expect(screen.getByText('回答时片段')).toBeInTheDocument()
    } else {
      expect(screen.queryByText('evidence.original_changed')).not.toBeInTheDocument()
      expect(screen.queryByTestId('answer-evidence-return-fragment')).not.toBeInTheDocument()
    }
  }
)

test('chat uses the existing file limit before fetching original bytes', async () => {
  const { attachmentFetch, restoreFetch } = mockAttachmentFetch()
  try {
    get.mockImplementation(async (url: string) => {
      if (url.includes('my-permission')) return { source_access: 'readable' }
      if (url.includes('/citations/42')) return snapshotOf('42')
      if (url === '/knowledge-documents/9')
        return { ...currentDocument, file_size: 101 * 1024 * 1024 }
      if (url.includes('/document-protection')) return { original_download_allowed: true }
      if (url.includes('/detail?')) return { document_id: 9, content: '备用解析正文' }
      throw new Error(url)
    })
    renderChatEvidence()
    const { panel, open } = await openOriginal()
    fireEvent.click(open)
    expect(
      await within(panel).findByTestId('knowledge-source-preview-too-large-download')
    ).toBeInTheDocument()
    expect(attachmentFetch).not.toHaveBeenCalled()
    expect(get.mock.calls.some(([url]) => url.includes('/detail?'))).toBe(false)
    fireEvent.click(within(panel).getByTestId('answer-original-parsed'))
    expect(await within(panel).findByText('备用解析正文')).toBeInTheDocument()
    expect(attachmentFetch).not.toHaveBeenCalled()
  } finally {
    restoreFetch()
  }
})

test.each(['first page', 'next page'] as const)(
  'chat removes only the revoked source after the %s is rejected',
  async failedPage => {
    let detailRequested = false
    get.mockImplementation(async (url: string) => {
      if (url.includes('/7/my-permission'))
        return { source_access: detailRequested ? 'visit-only' : 'readable' }
      if (url.includes('/8/my-permission')) return { source_access: 'readable' }
      if (url.includes('/citations/42')) return snapshotOf('42')
      if (url.includes('/citations/43')) return snapshotOf('43', '另一来源的片段')
      if (url === '/knowledge-documents/9') return { ...currentDocument, file_extension: '.txt' }
      if (url.includes('/document-protection')) return { original_download_allowed: true }
      if (url.includes('/detail?')) {
        if (failedPage === 'next page' && url.includes('offset=0')) {
          return {
            document_id: 9,
            content: '授权时读取的第一页',
            content_length: 20,
            truncated: true,
          }
        }
        detailRequested = true
        throw new ApiError('source revoked', 404)
      }
      throw new Error(url)
    })
    renderChatEvidence()
    const { panel, open } = await openOriginal()
    fireEvent.click(open)
    if (failedPage === 'next page') {
      expect(await within(panel).findByText('授权时读取的第一页')).toBeInTheDocument()
      fireEvent.click(within(panel).getByTestId('load-more-button'))
    }
    await waitFor(() => expect(panel).not.toBeInTheDocument())
    expect(screen.queryByText('授权时读取的第一页')).not.toBeInTheDocument()
    expect(screen.queryByText('回答时的快照')).not.toBeInTheDocument()
    expect(screen.queryByTestId('answer-citation-42')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('answer-citation-43'))
    expect(await screen.findByText('另一来源的片段')).toBeInTheDocument()
  }
)

test.each(['scope change', 'panel close'])(
  'a workbench %s discards a pending page of current content',
  async action => {
    let deliver!: (value: unknown) => void
    get.mockImplementation(async (url: string) => {
      if (url.includes('my-permission')) return { source_access: 'readable' }
      if (url.includes('/citations/42')) return snapshotOf('42')
      if (url === '/knowledge-documents/9') return { ...currentDocument, file_extension: '.txt' }
      if (url.includes('/document-protection')) return { original_download_allowed: true }
      if (url.includes('/detail?'))
        return new Promise(resolve => {
          deliver = resolve
        })
      throw new Error(url)
    })
    const view = (taskKey: string) => (
      <ChatEvidenceHost taskKey={taskKey}>
        <Answer />
      </ChatEvidenceHost>
    )
    const { rerender } = render(view('knowledge-7'))
    const { open } = await openOriginal()
    fireEvent.click(open)
    await waitFor(() => expect(deliver).toBeDefined())
    const page = get.mock.calls.find(([url]) => url.includes('/detail?'))
    const signal = page?.[1].signal as AbortSignal

    if (action === 'scope change') rerender(view('knowledge-8'))
    else fireEvent.click(screen.getByTestId('answer-evidence-close'))
    expect(signal.aborted).toBe(true)
    await act(async () => deliver({ document_id: 9, content: '迟到的原文页' }))
    expect(screen.queryByText('迟到的原文页')).not.toBeInTheDocument()
    expect(screen.queryByTestId('answer-evidence-panel')).not.toBeInTheDocument()
  }
)

test('a failed next page leaves the rendered content and retries the same offset', async () => {
  let pageAttempts = 0
  get.mockImplementation(async (url: string) => {
    if (url.includes('my-permission')) return { source_access: 'readable' }
    if (url.includes('/citations/42')) return snapshotOf('42')
    if (url === '/knowledge-documents/9') return { ...currentDocument, file_extension: '.txt' }
    if (url.includes('/document-protection')) return { original_download_allowed: true }
    if (url.includes('offset=0'))
      return { document_id: 9, content: '已读正文', content_length: 8, truncated: true }
    if (url.includes('offset=4')) {
      if (++pageAttempts === 1) throw new ApiError('page offline', 503)
      return { document_id: 9, content: '续页正文', content_length: 8, truncated: false }
    }
    throw new Error(url)
  })

  renderChatEvidence()
  const { panel, open } = await openOriginal()
  fireEvent.click(open)
  expect(await within(panel).findByText('已读正文')).toBeInTheDocument()
  fireEvent.click(within(panel).getByTestId('load-more-button'))
  expect(await within(panel).findByRole('alert')).toHaveTextContent('loadMoreFailed')
  expect(within(panel).getByText('已读正文')).toBeInTheDocument()
  fireEvent.click(within(panel).getByTestId('load-more-button'))
  expect(await within(panel).findByText('已读正文续页正文')).toBeInTheDocument()
  expect(get.mock.calls.filter(([url]) => url.includes('offset=0'))).toHaveLength(1)
  expect(pageAttempts).toBe(2)
})

test('original preview, token and signed download use the selected Backend', async () => {
  const baseUrl = 'https://selected-backend.example/api'
  jest.mocked(getApiBaseUrl).mockReturnValue(baseUrl)
  jest.mocked(getToken).mockReturnValue('test-token')
  const { attachmentFetch, restoreFetch } = mockAttachmentFetch()
  const anchorClick = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  try {
    attachmentFetch.mockImplementation(async (_url, request) =>
      request.method === 'GET'
        ? { ok: false, status: 503, json: async () => ({}) }
        : { ok: true, json: async () => ({ download_token: 'signed-token' }) }
    )
    get.mockImplementation(async (url: string) => {
      if (url.includes('my-permission')) return { source_access: 'readable' }
      if (url.includes('/citations/42')) return snapshotOf('42')
      if (url === '/knowledge-documents/9') return currentDocument
      if (url.includes('/document-protection')) return { original_download_allowed: true }
      throw new Error(url)
    })
    renderChatEvidence()
    const { panel, open } = await openOriginal()
    fireEvent.click(open)
    fireEvent.click(await within(panel).findByTestId('answer-original-download'))
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1))

    expect(attachmentFetch.mock.calls.map(([url]) => url)).toEqual([
      baseUrl + '/attachments/100/download',
      baseUrl + '/attachments/100/download-token',
    ])
    expect((anchorClick.mock.contexts[0] as HTMLAnchorElement).href).toBe(
      baseUrl + '/attachments/100/download?download_token=signed-token'
    )
  } finally {
    anchorClick.mockRestore()
    restoreFetch()
    jest.mocked(getApiBaseUrl).mockReturnValue('/api')
    jest.mocked(getToken).mockReset()
  }
})

test.each(['preview', 'download'] as const)(
  'explicit %s denial removes original-file access and keeps protected reading',
  async deniedOperation => {
    const canvas = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale: jest.fn(),
      translate: jest.fn(),
      rotate: jest.fn(),
      fillText: jest.fn(),
    } as unknown as CanvasRenderingContext2D)
    const image = jest
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,AA==')
    const { attachmentFetch, restoreFetch } = mockAttachmentFetch()
    jest.mocked(getToken).mockReturnValue('test-token')
    try {
      attachmentFetch.mockImplementation(async (_url, request) => {
        if (deniedOperation === 'download' && request.method === 'GET') {
          return {
            ok: true,
            headers: { get: () => 'application/pdf' },
            blob: async () => new Blob(['PDF document'], { type: 'application/pdf' }),
          }
        }
        return {
          ok: false,
          status: 403,
          json: async () => ({ detail: { code: 'DOCUMENT_DOWNLOAD_DISABLED' } }),
        }
      })
      get.mockImplementation(async (url: string) => {
        if (url.includes('my-permission')) return { source_access: 'readable' }
        if (url.includes('/citations/42')) return snapshotOf('42')
        if (url === '/knowledge-documents/9') return currentDocument
        if (url.includes('/document-protection'))
          return { original_download_allowed: true, watermark_text: '当前身份水印' }
        if (url.includes('/detail?')) return { document_id: 9, content: '可读的解析正文' }
        throw new Error(url)
      })
      renderChatEvidence()
      const { panel, open } = await openOriginal()
      fireEvent.click(open)
      if (deniedOperation === 'download') {
        expect(await within(panel).findByTestId('file-preview-body')).toBeInTheDocument()
        fireEvent.click(within(panel).getByTestId('answer-original-download'))
      }
      expect(await within(panel).findByText('可读的解析正文')).toBeInTheDocument()
      expect(within(panel).getByTestId('knowledge-document-watermark')).toHaveAttribute(
        'data-watermark-text',
        '当前身份水印'
      )
      expect(within(panel).queryByTestId('knowledge-source-preview')).not.toBeInTheDocument()
      expect(within(panel).queryByTestId('answer-original-file')).not.toBeInTheDocument()
      expect(within(panel).queryByTestId('answer-original-download')).not.toBeInTheDocument()
      fireEvent.click(within(panel).getByTestId('answer-evidence-return-fragment'))
      expect(within(panel).getByText('回答时的快照')).toBeInTheDocument()
    } finally {
      canvas.mockRestore()
      image.mockRestore()
      restoreFetch()
      jest.mocked(getToken).mockReset()
    }
  }
)

test('original Markdown preserves link text without guessing the target of wiki links', async () => {
  get.mockImplementation(async (url: string) => {
    if (url.includes('my-permission')) return { source_access: 'readable' }
    if (url.includes('/citations/42')) return snapshotOf('42')
    if (url === '/knowledge-documents/9') return { ...currentDocument, file_extension: '.md' }
    if (url.includes('/document-protection')) return { original_download_allowed: true }
    if (url.includes('/detail?')) {
      return {
        document_id: 9,
        content: '[相对链接](../notes/page.md) [外部链接](https://example.com/notes)',
      }
    }
    throw new Error(url)
  })
  renderChatEvidence()
  const { panel, open } = await openOriginal()
  fireEvent.click(open)
  expect(await within(panel).findByText('相对链接')).toBeInTheDocument()
  expect(within(panel).queryByRole('button', { name: '相对链接' })).not.toBeInTheDocument()
  expect(within(panel).queryByRole('link', { name: '相对链接' })).not.toBeInTheDocument()
  expect(within(panel).getByRole('link', { name: '外部链接' })).toHaveAttribute(
    'href',
    'https://example.com/notes'
  )
})
