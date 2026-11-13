import { projectRuntimeConversationTurns } from '@/features/workbench/runtimeConversationTurns'
import '@/i18n'
import { setPreferredWorkspaceOpener } from '@/lib/workspace-opener-preferences'
import { installExternalLinkHandler } from '@/lib/external-links'
import type { Attachment } from '@/types/api'
import type { ProcessingBlock, RuntimeConversationTurn } from '@/types/workbench'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import references from '../../../../packages/chat-core/test-fixtures/prompt-mentions.json'
import { AttachmentDownloadProvider } from './AttachmentDownloadProvider'
import { AttachmentPreviewContext } from './AttachmentPreviewContext'
import type { WorkspaceAttachmentPreviewSource } from '@/types/workspace-files'
import { MessageList } from './MessageList'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import { WorkspaceFileReaderProvider } from './WorkspaceFileReaderProvider'
import { ComposerCatalogContext } from './composer/ComposerCatalogContext'
import { desktopComposerCatalogStore } from './composer/desktopComposerCatalog'
import { clearImagePreviewCache } from './imagePreviewCache'

const desktopHostMock = vi.hoisted(() => ({
  invoke: vi.fn(),
}))
const electronLocalFileMock = vi.hoisted(() => ({
  read: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3])),
}))
const runtimeMock = vi.hoisted(() => ({ electron: false }))
const openExternalUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue(true))
const requestEmbeddedBrowserOpenMock = vi.hoisted(() => vi.fn(() => true))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: (...args: unknown[]) => desktopHostMock.invoke(...args),
}))
vi.mock('@/desktop/inlineVisualization', () => ({
  readInlineVisualizationHtml: (...args: unknown[]) => desktopHostMock.invoke(...args),
}))
vi.mock('@/lib/electron-local-file', () => ({
  readElectronLocalFile: (...args: unknown[]) => electronLocalFileMock.read(...args),
}))
vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isDesktopRuntime: () => runtimeMock.electron,
  isElectronRuntime: () => runtimeMock.electron,
}))
vi.mock('@/lib/external-links', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/external-links')>()),
  openExternalUrl: openExternalUrlMock,
}))
vi.mock('@/lib/embedded-browser', () => ({
  requestEmbeddedBrowserOpen: requestEmbeddedBrowserOpenMock,
}))

describe('MessageList', () => {
  test.each([
    { name: 'message list', Conversation: MessageList },
    { name: 'scrollable conversation', Conversation: ScrollableMessageArea },
  ])(
    'previews sent text attachments independently of workspace opener preferences in $name',
    async ({ Conversation }) => {
      runtimeMock.electron = true
      // Supply a mounted viewport before the virtualizer's initial measurement.
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800)
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
      const viewport = document.createElement('div')
      viewport.scrollTo = vi.fn()
      document.body.appendChild(viewport)
      const scrollProps = { externalScrollRef: { current: viewport } }
      desktopHostMock.invoke.mockImplementation(async command => {
        if (command === 'workspace.listOpeners') {
          return [
            { id: 'vscode', available: true },
            { id: 'cursor', available: true },
          ]
        }
      })
      setPreferredWorkspaceOpener('/workspace/first', 'terminal')
      setPreferredWorkspaceOpener('/workspace/second', 'powershell')
      const openPreview = vi.fn<(source: WorkspaceAttachmentPreviewSource) => void>()
      const path = '/attachments/sample.md'
      const onOpenWorkspaceFile = vi.fn()
      const messages = [
        {
          id: 'sent-file',
          role: 'user' as const,
          content: '',
          status: 'done' as const,
          createdAt: '2026-09-20T00:00:00Z',
          attachments: [
            {
              id: 45,
              filename: 'sample.md',
              file_size: 10,
              mime_type: 'text/markdown',
              status: 'ready',
              file_extension: '.md',
              created_at: '2026-09-20T00:00:00Z',
              local_path: path,
            } satisfies Attachment,
          ],
        },
      ]
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <AttachmentPreviewContext.Provider value={openPreview}>
          {children}
        </AttachmentPreviewContext.Provider>
      )
      const { rerender } = render(
        <Conversation
          {...scrollProps}
          messages={messages}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
        />,
        { wrapper }
      )
      await userEvent.click(screen.getByTestId('message-text-attachment'))
      expect(openPreview).toHaveBeenCalledTimes(1)
      expect(openPreview.mock.calls[0][0].filename).toBe('sample.md')
      await openPreview.mock.calls[0][0].loadFile()
      expect(electronLocalFileMock.read).toHaveBeenCalledWith(path)
      rerender(
        <Conversation
          {...scrollProps}
          messages={messages}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
        />
      )
      await userEvent.click(screen.getByTestId('message-text-attachment'))
      expect(openPreview).toHaveBeenCalledTimes(2)
      setPreferredWorkspaceOpener('/workspace/second', 'vscode')
      await userEvent.click(screen.getByTestId('message-text-attachment'))
      expect(openPreview).toHaveBeenCalledTimes(3)
      expect(desktopHostMock.invoke).not.toHaveBeenCalledWith(
        'workspace.openFile',
        expect.anything()
      )
      expect(desktopHostMock.invoke).not.toHaveBeenCalledWith('shell.openPath', expect.anything())
      expect(onOpenWorkspaceFile).not.toHaveBeenCalled()
      viewport.remove()
    }
  )

  test('disables unknown skills after catalog failure and enables them after refresh', async () => {
    const path = '/Users/me/.agents/skills/test-skill/SKILL.md'
    const listSkills = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([{ name: 'test-skill', path, description: '', source: 'codex' }])
    const onOpenLocalSkillFile = vi.fn()
    render(
      <ComposerCatalogContext.Provider
        value={{
          appsStore: desktopComposerCatalogStore,
          catalogEvents: { catalogChanged: 'test-skill-refresh' },
          listSkills,
        }}
      >
        <MessageList
          messages={[
            {
              id: 'skill',
              role: 'user',
              content: `[$test-skill](${path})`,
              status: 'done',
              createdAt: '2026-09-18T00:00:00Z',
            },
          ]}
          onOpenLocalSkillFile={onOpenLocalSkillFile}
        />
      </ComposerCatalogContext.Provider>
    )
    const token = screen.getByTestId('sent-local-skill-token-test-skill')
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(1))
    expect(token).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(token)
    expect(onOpenLocalSkillFile).not.toHaveBeenCalled()
    act(() => window.dispatchEvent(new Event('test-skill-refresh')))
    await waitFor(() => expect(token).toHaveAttribute('aria-disabled', 'false'))
    fireEvent.click(token)
    expect(onOpenLocalSkillFile).toHaveBeenCalledWith(path)
  })

  test('ignores a stale skill catalog after switching conversations', async () => {
    const path = '/Users/me/.agents/skills/test-skill/SKILL.md'
    let resolveOld!: (
      skills: { name: string; path: string; source: string; description: string }[]
    ) => void
    const oldSource = vi.fn(
      () =>
        new Promise<{ name: string; path: string; source: string; description: string }[]>(
          resolve => {
            resolveOld = resolve
          }
        )
    )
    const newSource = vi.fn().mockResolvedValue([])
    const onOpenLocalSkillFile = vi.fn()
    const content = (listSkills: typeof oldSource) => (
      <ComposerCatalogContext.Provider
        value={{
          appsStore: desktopComposerCatalogStore,
          catalogEvents: {},
          listSkills,
        }}
      >
        <MessageList
          messages={[
            {
              id: 'skill',
              role: 'user',
              content: `[$test-skill](${path})`,
              status: 'done',
              createdAt: '2026-09-18T00:00:00Z',
            },
          ]}
          onOpenLocalSkillFile={onOpenLocalSkillFile}
        />
      </ComposerCatalogContext.Provider>
    )
    const { rerender } = render(content(oldSource))
    await waitFor(() => expect(oldSource).toHaveBeenCalledOnce())
    rerender(content(newSource))
    await waitFor(() => expect(newSource).toHaveBeenCalledOnce())
    await act(async () => {
      resolveOld([{ name: 'test-skill', path, description: '', source: 'codex' }])
    })
    const token = screen.getByTestId('sent-local-skill-token-test-skill')
    expect(token).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(token)
    expect(onOpenLocalSkillFile).not.toHaveBeenCalled()
  })

  test.each(references.filter(item => item.kind === 'skill'))(
    'renders an unregistered skill without enabling file access: $reference',
    fixture => {
      const onOpenLocalSkillFile = vi.fn()
      render(
        <MessageList
          messages={[
            {
              id: 'unknown-skill',
              role: 'user',
              content: fixture.reference,
              status: 'done',
              createdAt: '2026-09-18T00:00:00Z',
            },
          ]}
          onOpenLocalSkillFile={onOpenLocalSkillFile}
        />
      )
      const token = screen.getByTestId('sent-local-skill-token-test-skill')
      expect(token).toHaveAttribute('aria-disabled', 'true')
      expect(token).toHaveAttribute('tabindex', '-1')
      fireEvent.click(token)
      expect(onOpenLocalSkillFile).not.toHaveBeenCalled()
    }
  )

  test('keeps runtime content truncation invisible while rendering the retained content', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-truncated-content',
            role: 'assistant',
            content: '这是截断后保留的最新回复',
            contentTruncated: true,
            contentOriginalChars: 200_001,
            status: 'streaming',
            createdAt: '2026-09-14T08:00:00Z',
          },
        ]}
      />
    )

    expect(screen.getByText('这是截断后保留的最新回复')).toBeInTheDocument()
    expect(screen.queryByText(/早期内容.*卸载/)).not.toBeInTheDocument()
    expect(screen.queryByText(/加载完整输出/)).not.toBeInTheDocument()
  })

  test('offers Electron selection actions for streaming process text before tools', async () => {
    runtimeMock.electron = true
    const onAddSelectionToConversation = vi.fn()
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-process-selection',
            role: 'assistant',
            content: '',
            status: 'streaming',
            blocks: [
              {
                id: 'process-before-tool',
                type: 'text',
                content: '我现在沿唯一正确链路继续取证。',
                status: 'done',
                createdAt: 1770000000000,
              },
              {
                id: 'running-tool',
                type: 'tool',
                toolName: 'Bash',
                toolInput: { command: 'pwd' },
                status: 'streaming',
                createdAt: 1770000000001,
              },
            ],
            createdAt: '2026-08-31T06:00:00Z',
          },
        ]}
        onAddSelectionToConversation={onAddSelectionToConversation}
        onAskSelectionInSidebar={vi.fn()}
      />
    )

    selectText(screen.getByTestId('process-text-block'), '唯一正确链路')
    await userEvent.click(await screen.findByTestId('add-selection-to-conversation-button'))
    expect(onAddSelectionToConversation).toHaveBeenCalledWith('唯一正确链路')
  })

  test('keeps captured selection actions when streaming replaces the selected text node', async () => {
    const onAddSelectionToConversation = vi.fn()
    const { rerender } = render(
      <MessageList
        messages={[
          {
            id: 'assistant-streaming-selection',
            role: 'assistant',
            content: 'Select this response',
            status: 'streaming',
            createdAt: '2026-07-15T10:00:00Z',
          },
        ]}
        onAddSelectionToConversation={onAddSelectionToConversation}
        onAskSelectionInSidebar={vi.fn()}
      />
    )

    const content = screen.getByTestId('assistant-message-content')
    const range = document.createRange()
    range.setStart(firstTextNode(content), 0)
    range.setEnd(firstTextNode(content), 6)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(range)
    fireEvent.pointerUp(content)

    expect(await screen.findByTestId('message-selection-actions')).toBeInTheDocument()

    rerender(
      <MessageList
        messages={[
          {
            id: 'assistant-streaming-selection',
            role: 'assistant',
            content: 'Select this response while it grows',
            status: 'streaming',
            createdAt: '2026-07-15T10:00:00Z',
          },
        ]}
        onAddSelectionToConversation={onAddSelectionToConversation}
        onAskSelectionInSidebar={vi.fn()}
      />
    )
    document.getSelection()?.removeAllRanges()
    fireEvent(document, new Event('selectionchange'))

    expect(await screen.findByTestId('message-selection-actions')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('add-selection-to-conversation-button'))
    expect(onAddSelectionToConversation).toHaveBeenCalledWith('Select')
  })

  test('shows a remote image read failure inside the tool detail', async () => {
    const user = userEvent.setup()
    const readWorkspaceFileChunk = vi.fn().mockRejectedValue(new Error('Device is offline'))

    render(
      <WorkspaceFileReaderProvider readWorkspaceFileChunk={readWorkspaceFileChunk}>
        <MessageList
          imageTarget={{ deviceId: 'remote-device', workspacePath: '/workspace' }}
          messages={[
            {
              id: 'assistant-remote-image-error',
              role: 'assistant',
              content: 'Done.',
              status: 'done',
              createdAt: '2026-09-29T10:00:00Z',
              blocks: [
                {
                  id: 'view-remote-image-error',
                  subtaskId: '1',
                  type: 'tool',
                  toolName: 'view_image',
                  toolInput: { path: 'sunset.png' },
                  status: 'done',
                  createdAt: Date.now(),
                },
              ],
            },
          ]}
        />
      </WorkspaceFileReaderProvider>
    )

    await user.click(screen.getByTestId('final-processing-toggle'))
    await user.click(screen.getByTestId('processing-summary-toggle'))
    await user.click(screen.getByRole('button', { name: /展开工具详情/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('图片加载失败: Device is offline')
    expect(readWorkspaceFileChunk).toHaveBeenCalledWith(
      'remote-device',
      '/workspace/sunset.png',
      0,
      '/workspace'
    )
    expect(screen.queryByTestId('image-view-preview')).not.toBeInTheDocument()
  })

  test('keeps a streamed oversized code chunk mounted after completion', () => {
    runtimeMock.electron = true
    const intersectionCallbacks: IntersectionObserverCallback[] = []
    class IntersectionObserverMock {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallbacks.push(callback)
      }
      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
      takeRecords = vi.fn(() => [])
      root = null
      rootMargin = '1600px 0px'
      thresholds = [0]
    }
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
    const longCode = [
      '```sql',
      ...Array.from(
        { length: 110 },
        (_, index) =>
          `SELECT ${index + 1} AS value_${index + 1}, '${'payload '.repeat(8)}' AS payload;`
      ),
      '```',
    ].join('\n')
    const content = [
      longCode,
      ...Array.from(
        { length: 8 },
        (_, index) => `### Tail section ${index + 1}\n\n${'tail '.repeat(80)}\n`
      ),
    ].join('\n')
    const text: RuntimeConversationTurn['items'][number] = {
      id: 'assistant-turn-1',
      type: 'assistant_text',
      content,
      createdAt: '2026-09-21T10:00:00Z',
    }
    const reasoning: RuntimeConversationTurn['items'][number] = {
      id: 'native-reasoning',
      type: 'block',
      block: { id: 'native-reasoning', type: 'thinking', content: 'Plan', createdAt: 1 },
    }
    const turn: RuntimeConversationTurn = {
      id: 'turn-1',
      status: 'streaming',
      items: [text, reasoning],
    }
    const streamingMessages = projectRuntimeConversationTurns([turn])

    const { container, rerender } = render(<MessageList messages={streamingMessages} />)
    const codeNode = container.querySelector('code')
    expect(codeNode).not.toBeNull()

    rerender(
      <MessageList
        messages={projectRuntimeConversationTurns([
          { ...turn, status: 'done', items: [reasoning, { ...text, id: 'native-final' }] },
        ])}
      />
    )

    act(() => {
      intersectionCallbacks.forEach(callback =>
        callback(
          [{ isIntersecting: false } as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
      )
    })

    expect(container.querySelector('code')).toBe(codeNode)
    expect(
      codeNode
        ?.closest('[data-markdown-window-chunk]')
        ?.querySelector('[data-markdown-window-placeholder]')
    ).toBeNull()
  })

  test('renders cancelled assistant turns like stopped Codex turns', () => {
    const commandBlock: ProcessingBlock = {
      id: 'call-1',
      subtaskId: 21,
      type: 'tool',
      toolName: 'Bash',
      toolInput: { command: 'pnpm test' },
      status: 'done',
      createdAt: Date.parse('2026-06-11T10:09:18Z'),
    }

    render(
      <MessageList
        devices={[
          {
            id: 1,
            device_id: 'device-1',
            name: 'Device 1',
            status: 'online',
            is_default: false,
          },
        ]}
        onLoadFileChangesDiff={vi.fn().mockResolvedValue('')}
        onRevertFileChanges={vi.fn()}
        messages={[
          {
            id: 'assistant-stopped',
            subtaskId: 21,
            role: 'assistant',
            content: 'interrupted',
            status: 'done',
            runtimeStatus: 'cancelled',
            createdAt: '2026-06-11T10:00:00Z',
            blocks: [commandBlock],
            fileChanges: {
              version: 1,
              status: 'active',
              artifact_id: 'turn-21',
              device_id: 'device-1',
              workspace_path: '/workspace/project',
              file_count: 1,
              additions: 4,
              deletions: 2,
              files: [
                {
                  path: 'src/main.ts',
                  change_type: 'modified',
                  additions: 4,
                  deletions: 2,
                  binary: false,
                },
              ],
            },
          },
        ]}
      />
    )

    expect(screen.queryByText('interrupted')).not.toBeInTheDocument()
    const summary = screen.getByRole('button', { name: /调用 1 个工具 已处理/ })
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(summary)
    expect(screen.getByText('运行 pnpm test')).toBeInTheDocument()
    expect(screen.queryByTestId('processing-activity-group-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('file-changes-card')).toHaveTextContent('已编辑 main.ts')
    const stoppedNotice = screen.getByTestId('assistant-stopped-notice')
    expect(stoppedNotice).toHaveTextContent('你在 9m 18s 后停止了')
    expect(stoppedNotice).not.toHaveClass('border-b')
  })

  const originalCreateObjectUrl = URL.createObjectURL
  const originalRevokeObjectUrl = URL.revokeObjectURL

  afterEach(() => {
    clearImagePreviewCache()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    runtimeMock.electron = false
    desktopHostMock.invoke.mockReset()
    electronLocalFileMock.read.mockReset()
    electronLocalFileMock.read.mockResolvedValue(Uint8Array.from([1, 2, 3]))
    openExternalUrlMock.mockClear()
    localStorage.clear()
    URL.createObjectURL = originalCreateObjectUrl
    URL.revokeObjectURL = originalRevokeObjectUrl
    delete (navigator as unknown as { clipboard?: Clipboard }).clipboard
  })

  test('hides the stale reasoning summary once assistant text starts streaming', () => {
    const blocks: ProcessingBlock[] = [
      {
        id: 'thinking-1',
        subtaskId: 11,
        type: 'thinking',
        content: '检查运行日志并定位事件边界',
        status: 'done',
        createdAt: 1770000000000,
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-blocks',
            role: 'assistant',
            content: '已经定位到问题，接下来修复状态边界。',
            status: 'streaming',
            blocks,
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
    expect(screen.queryByText('检查运行日志并定位事件边界')).not.toBeInTheDocument()
  })

  test('does not restore hidden failed content from runtime display order', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-failed-interleaved-process',
            role: 'assistant',
            content: 'Error: raw provider failure',
            error: 'The request failed',
            status: 'failed',
            blocks: [
              {
                id: 'process-after-error',
                subtaskId: 11,
                type: 'text',
                content: '最后一次诊断信息。',
                status: 'done',
                createdAt: 1770000001000,
              },
            ],
            runtimeDisplayItems: [
              {
                id: 'assistant-error',
                type: 'assistant_text',
                content: 'Error: raw provider failure',
              },
              {
                id: 'process-after-error',
                type: 'block',
              },
            ],
            createdAt: '2026-08-14T08:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('assistant-message-content')).not.toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-details')).toHaveTextContent(
      'Error: raw provider failure'
    )
    expect(screen.getByText('最后一次诊断信息。')).toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-card')).toBeInTheDocument()
  })

  test('keeps a running tool visible when streamed answer text appears', () => {
    const blocks: ProcessingBlock[] = [
      {
        id: 'tool-1',
        subtaskId: 11,
        type: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
        toolOutput: '/workspace/project\n',
        status: 'streaming',
        createdAt: 1770000000000,
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-streaming-with-process',
            role: 'assistant',
            content: '这是正在流式输出的最终答案。',
            status: 'streaming',
            blocks,
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    const finalAnswer = screen.getByTestId('message-assistant').querySelector('p')
    expect(finalAnswer).toHaveTextContent('这是正在流式输出的最终答案。')
    const processStatus = screen.getByTestId('processing-summary-header')
    const collapseContent = screen.getByTestId('processing-collapse-content')

    expect(
      processStatus.compareDocumentPosition(finalAnswer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(collapseContent).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByTestId('processing-summary-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('processing-live-preview')).toBeInTheDocument()
    expect(screen.getByText('正在运行 pwd')).toBeInTheDocument()
    expect(screen.queryByText('/workspace/project')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '展开工具详情' }))

    expect(screen.getByText('/workspace/project')).toBeInTheDocument()
  })

  test('keeps processing expansion state scoped to each conversation', () => {
    const blocks: ProcessingBlock[] = [
      {
        id: 'tool-1',
        subtaskId: 11,
        type: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
        toolOutput: '/workspace/project\n',
        status: 'done',
        createdAt: 1770000000000,
      },
    ]
    const buildMessage = (id: string): Parameters<typeof MessageList>[0]['messages'][number] => ({
      id,
      role: 'assistant',
      content: 'Done',
      status: 'done',
      blocks,
      createdAt: '2026-06-24T08:00:01.000Z',
    })

    const { rerender } = render(
      <MessageList conversationKey="conversation-a" messages={[buildMessage('assistant-a')]} />
    )

    fireEvent.click(screen.getByTestId('final-processing-toggle'))
    expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')

    rerender(
      <MessageList conversationKey="conversation-b" messages={[buildMessage('assistant-b')]} />
    )

    expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')

    rerender(
      <MessageList conversationKey="conversation-a" messages={[buildMessage('assistant-a')]} />
    )

    expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')
  })

  test('opens a deduped reference card with the absolute path from the assistant link', async () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <MessageList
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'assistant-reference-path',
            role: 'assistant',
            content:
              '已保存为设计文档：[Excel 行感知分块设计](/workspace/project/260817_1436_Excel行感知分块设计.md)',
            status: 'done',
            createdAt: '2026-08-17T08:00:01.000Z',
            references: [
              {
                path: 'docs/../260817_1436_Excel行感知分块设计.md',
                lineStart: 12,
                lineEnd: 18,
              },
            ],
          },
        ]}
      />
    )

    await userEvent.click(screen.getByTestId('codex-reference-card'))

    expect(onOpenWorkspaceFile).toHaveBeenCalledWith(
      '/workspace/project/260817_1436_Excel行感知分块设计.md',
      {
        lineStart: 12,
        lineEnd: 18,
      }
    )
  })

  test('previews an HTML workspace link through the file panel', async () => {
    runtimeMock.electron = true
    requestEmbeddedBrowserOpenMock.mockClear()
    const onOpenWorkspaceFile = vi.fn()
    render(
      <MessageList
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'assistant-html-file',
            role: 'assistant',
            content: '写好了：[agreement.html](/home/ubuntu/agreement.html)',
            status: 'done',
            createdAt: '2026-11-11T10:47:00.000Z',
          },
        ]}
      />
    )

    await userEvent.click(screen.getByTestId('assistant-markdown-link'))

    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('/home/ubuntu/agreement.html')
    expect(requestEmbeddedBrowserOpenMock).not.toHaveBeenCalled()
  })

  test('downloads local path image attachments from Electron file bytes', async () => {
    runtimeMock.electron = true
    vi.stubGlobal('fetch', vi.fn())
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:electron-image-download')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    const attachment: Attachment = {
      id: -1,
      filename: 'screenshot.png',
      file_size: 0,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-06-26T15:33:00.000+08:00',
      local_preview_url: '/var/folders/tmp/codex-clipboard/screenshot.png',
    }

    render(
      <MessageList
        messages={[
          {
            id: 'local-codex-image',
            role: 'user',
            content: '解释一下这张图片',
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-06-26T15:33:00.000+08:00',
          },
        ]}
      />
    )

    await userEvent.click(await screen.findByTestId('message-image-preview'))
    await screen.findByTestId('attachment-image-lightbox-image')
    await userEvent.click(screen.getByTestId('attachment-image-download'))

    await waitFor(() => {
      expect(click).toHaveBeenCalledOnce()
    })
    expect(electronLocalFileMock.read).toHaveBeenCalledWith(
      '/var/folders/tmp/codex-clipboard/screenshot.png'
    )
    expect(desktopHostMock.invoke).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('prefers persisted image attachments over stale Codex local image mentions', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const attachment: Attachment = {
      id: 43,
      filename: 'codex-clipboard.png',
      file_size: 1024,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-25T15:08:00.000+08:00',
      local_preview_url: 'blob:persisted-image',
    }

    render(
      <MessageList
        messages={[
          {
            id: 'codex-image-mention-with-attachment',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## codex-clipboard.png: /var/folders/tmp/codex-clipboard.png',
              '',
              '## My request for Codex:',
              '发出去图片',
            ].join('\n'),
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(await screen.findByTestId('message-image-preview')).toHaveAttribute(
      'src',
      'blob:persisted-image'
    )
    expect(screen.queryByTestId('message-local-image-preview')).not.toBeInTheDocument()
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('发出去图片')
  })

  test('does not render raw local image paths when Electron file reading fails', async () => {
    runtimeMock.electron = true
    electronLocalFileMock.read.mockRejectedValueOnce(new Error('file unavailable'))

    render(
      <MessageList
        messages={[
          {
            id: 'browser-codex-image-mention',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## image.png: /Users/yunpeng7/.wework/workspace/attachments/10406026969952/0/image.png',
              '',
              '## My request for Codex:',
              '分析下这个图片',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    await waitFor(() =>
      expect(screen.queryByTestId('message-local-image-preview')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('分析下这个图片')
  })

  test('hides Codex local image previews when the Electron file read fails', async () => {
    runtimeMock.electron = true
    electronLocalFileMock.read.mockRejectedValueOnce(new Error('file unavailable'))

    render(
      <MessageList
        messages={[
          {
            id: 'codex-image-mention-load-failure',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## image.png: /var/folders/tmp/codex-clipboard.png',
              '',
              '## My request for Codex:',
              '分析下这个图片',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    await waitFor(() =>
      expect(screen.queryByTestId('message-local-image-preview')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('分析下这个图片')
  })

  test('renders assistant markdown attachment images through authenticated blob previews', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:assistant-markdown-image')
    URL.revokeObjectURL = vi.fn()
    const fetchAttachmentBlob = vi
      .fn()
      .mockResolvedValue(new Blob(['image'], { type: 'image/png' }))

    render(
      <AttachmentDownloadProvider fetchAttachmentBlob={fetchAttachmentBlob}>
        <MessageList
          messages={[
            {
              id: 'assistant-image',
              role: 'assistant',
              content: '生成结果：\n\n![diagram](/api/attachments/43/download)',
              status: 'done',
              createdAt: '2026-05-25T15:08:00.000+08:00',
            },
          ]}
        />
      </AttachmentDownloadProvider>
    )

    expect(await screen.findByTestId('assistant-markdown-image')).toHaveAttribute(
      'src',
      'blob:assistant-markdown-image'
    )
    expect(screen.getByTestId('assistant-markdown-image')).toHaveAttribute('alt', 'diagram')
    expect(fetchAttachmentBlob).toHaveBeenCalledWith(43)
  })

  test.each([
    {
      source: '/tmp/result.png',
      title: 'Absolute path result',
    },
    {
      source: 'file:///tmp/result.png',
      title: 'File URL result',
    },
  ])(
    'renders a titled assistant markdown local image from $source through an Electron blob preview',
    async ({ source, title }) => {
      runtimeMock.electron = true
      URL.createObjectURL = vi.fn(() => 'blob:assistant-local-image')
      URL.revokeObjectURL = vi.fn()

      render(
        <MessageList
          messages={[
            {
              id: 'assistant-local-image',
              role: 'assistant',
              content: `生成结果：\n\n![local result](${source} "${title}")`,
              status: 'done',
              createdAt: '2026-05-25T15:08:00.000+08:00',
            },
          ]}
        />
      )

      expect(await screen.findByTestId('assistant-markdown-image')).toHaveAttribute(
        'src',
        'blob:assistant-local-image'
      )
      expect(screen.getByTestId('assistant-markdown-image')).toHaveAttribute('alt', 'local result')
      expect(electronLocalFileMock.read).toHaveBeenCalledWith('/tmp/result.png')
    }
  )

  test('renders an error when an assistant markdown local image cannot be read', async () => {
    runtimeMock.electron = true
    electronLocalFileMock.read.mockRejectedValueOnce(new Error('file unavailable'))

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-missing-local-image',
            role: 'assistant',
            content: '生成结果：\n\n![temporary result](/tmp/result.png)',
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(await screen.findByTestId('assistant-markdown-image-error')).toHaveTextContent(
      'temporary result'
    )
    expect(electronLocalFileMock.read).toHaveBeenCalledWith('/tmp/result.png')
    expect(screen.queryByTestId('assistant-markdown-image')).not.toBeInTheDocument()
  })

  test('shows edit action only for the final completed user turn and submits edited text', async () => {
    const onEditLastUserMessage = vi.fn().mockResolvedValue(true)
    render(
      <MessageList
        messages={[
          {
            id: 'user-old',
            role: 'user',
            content: '旧问题',
            status: 'done',
            createdAt: '2026-05-25T15:00:00.000+08:00',
          },
          {
            id: 'assistant-old',
            role: 'assistant',
            content: '旧回答',
            status: 'done',
            createdAt: '2026-05-25T15:01:00.000+08:00',
          },
          {
            id: 'user-last',
            role: 'user',
            content: '最后问题',
            status: 'done',
            createdAt: '2026-05-25T15:02:00.000+08:00',
          },
          {
            id: 'assistant-last',
            role: 'assistant',
            content: '最后回答',
            status: 'done',
            createdAt: '2026-05-25T15:03:00.000+08:00',
          },
        ]}
        onEditLastUserMessage={onEditLastUserMessage}
        canEditLastUserMessage
      />
    )

    expect(screen.getAllByTestId('edit-message-button')).toHaveLength(1)

    const lastUserMessage = screen.getAllByTestId('message-user').at(-1) as HTMLElement
    const lastHoverRegion = within(lastUserMessage).getByTestId('message-hover-region')
    expect(lastHoverRegion).toBeInstanceOf(HTMLElement)
    fireEvent.pointerEnter(lastHoverRegion as HTMLElement)

    expect(screen.getByTestId('edit-message-label')).toHaveTextContent('编辑')
    expect(screen.getByTestId('edit-message-button')).toHaveAttribute('title', '编辑')

    await userEvent.click(screen.getByTestId('edit-message-button'))
    expect(screen.getByTestId('edit-user-message-form')).toBeInTheDocument()
    const editor = screen.getByTestId('edit-user-message-textarea') as HTMLElement & {
      value: string
    }
    expect(editor).toHaveTextContent('最后问题')

    await userEvent.click(screen.getByTestId('cancel-edit-user-message-button'))
    expect(screen.queryByTestId('edit-user-message-form')).not.toBeInTheDocument()

    fireEvent.pointerEnter(lastHoverRegion as HTMLElement)
    await userEvent.click(screen.getByTestId('edit-message-button'))

    const activeEditor = screen.getByTestId('edit-user-message-textarea') as HTMLElement & {
      value: string
    }

    act(() => {
      activeEditor.value = '编辑后的问题\n继续'
    })

    expect(onEditLastUserMessage).not.toHaveBeenCalled()
    expect(activeEditor.value).toBe('编辑后的问题\n继续')

    await userEvent.keyboard('{Enter}')

    await waitFor(() =>
      expect(onEditLastUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-last' }),
        '编辑后的问题\n继续'
      )
    )
    expect(screen.queryByTestId('edit-user-message-form')).not.toBeInTheDocument()
  })

  test('renders GitHub link chips in the edit form and opens the link edit popover', async () => {
    render(
      <MessageList
        messages={[
          {
            id: 'user-github-link',
            role: 'user',
            content: '[wecode-ai/Wegent#2350](https://github.com/wecode-ai/Wegent/pull/2350)',
            status: 'done',
            createdAt: '2026-07-30T10:00:00.000Z',
          },
          {
            id: 'assistant-github-link',
            role: 'assistant',
            content: 'OK',
            status: 'done',
            createdAt: '2026-07-30T10:01:00.000Z',
          },
        ]}
        onEditLastUserMessage={vi.fn().mockResolvedValue(true)}
        canEditLastUserMessage
      />
    )

    const userHoverRegion = screen
      .getByText('wecode-ai/Wegent#2350')
      .closest('[data-testid="message-hover-region"]') as HTMLElement
    fireEvent.pointerEnter(userHoverRegion)
    await userEvent.click(screen.getByTestId('edit-message-button'))

    const form = screen.getByTestId('edit-user-message-form')
    const chip = within(form).getByTestId('composer-link-chip')
    expect(chip).toHaveTextContent('wecode-ai/Wegent#2350')

    fireEvent.click(chip)
    expect(await screen.findByTestId('link-edit-popover')).toBeInTheDocument()
  })

  test('hides edit action while the final user turn is still streaming', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'user-last',
            role: 'user',
            content: '最后问题',
            status: 'done',
            createdAt: '2026-05-25T15:02:00.000+08:00',
          },
          {
            id: 'assistant-last',
            role: 'assistant',
            content: '正在回答',
            status: 'streaming',
            createdAt: '2026-05-25T15:03:00.000+08:00',
          },
        ]}
        onEditLastUserMessage={vi.fn()}
        canEditLastUserMessage
      />
    )

    expect(screen.queryByTestId('edit-message-button')).not.toBeInTheDocument()
  })

  test('continues a completed Codex turn in a new task', async () => {
    let resolveFork: (() => void) | undefined
    const onForkMessage = vi.fn(() => new Promise<void>(resolve => (resolveFork = resolve)))
    const message = {
      id: 'assistant-turn-1',
      role: 'assistant' as const,
      content: '已完成当前修改。',
      status: 'done' as const,
      turnId: 'turn-1',
      createdAt: '2026-05-25T18:38:00.000+08:00',
    }

    render(<MessageList messages={[message]} onForkMessage={onForkMessage} />)

    const button = screen.getByTestId('fork-message-button')
    expect(button).toHaveAttribute('aria-label', '在新任务中继续')
    await userEvent.click(button)
    expect(onForkMessage).toHaveBeenCalledWith(message)
    expect(button).toBeDisabled()

    await userEvent.click(button)
    expect(onForkMessage).toHaveBeenCalledTimes(1)

    resolveFork?.()
    await waitFor(() => expect(button).not.toBeDisabled())
  })

  test('keeps expanded tool details open while final text streams, then collapses when done', () => {
    const completedBlock: ProcessingBlock = {
      id: 'call-1',
      subtaskId: 1,
      type: 'tool',
      toolName: 'Bash',
      toolInput: { command: 'rg -n "foo" src' },
      status: 'done',
      createdAt: 1770000000000,
    }

    const streamingMessage = {
      id: '2',
      role: 'assistant' as const,
      content: '',
      status: 'streaming' as const,
      createdAt: '2026-05-25T18:46:00.000+08:00',
    }
    const { rerender } = render(
      <MessageList
        messages={[
          {
            ...streamingMessage,
            blocks: [completedBlock],
          },
        ]}
      />
    )

    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
    expect(screen.getByTestId('processing-live-preview')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开工具详情' }))

    rerender(
      <MessageList
        messages={[
          {
            ...streamingMessage,
            content: 'Let me explore the repo structure for you.',
            blocks: [completedBlock],
          },
        ]}
      />
    )

    expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '收起工具详情' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('processing-live-preview')).toBeInTheDocument()
    const content = screen.getByTestId('assistant-message-content')

    rerender(
      <MessageList
        messages={[
          {
            ...streamingMessage,
            content: 'Let me explore the repo structure for you. More text.',
            blocks: [completedBlock],
          },
        ]}
      />
    )

    expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '收起工具详情' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('assistant-message-content')).toBe(content)

    rerender(
      <MessageList
        isWaitingForAssistant
        messages={[
          {
            ...streamingMessage,
            content: 'Let me explore the repo structure for you. More text. Done.',
            status: 'done',
            blocks: [completedBlock],
          },
        ]}
      />
    )

    expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '收起工具详情' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('assistant-message-content')).toBe(content)
    expect(screen.getByTestId('message-assistant-waiting')).toBeInTheDocument()

    rerender(
      <MessageList
        messages={[
          {
            ...streamingMessage,
            content: 'Let me explore the repo structure for you. More text. Done.',
            status: 'done',
            blocks: [completedBlock],
          },
        ]}
      />
    )

    expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: '收起工具详情' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('assistant-message-content')).toBe(content)

    fireEvent.click(screen.getByRole('button', { name: '收起工具详情' }))

    expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  test('isolates tool detail expansion by conversation, turn and call across guidance segments', () => {
    const buildTurn = (id: string): RuntimeConversationTurn => ({
      id,
      status: 'streaming',
      items: [
        {
          id: 'before-guidance',
          type: 'block',
          block: {
            id: 'before-guidance',
            type: 'tool',
            toolName: 'Bash',
            toolInput: { command: 'pwd' },
            status: 'done',
            createdAt: 1770000000000,
          },
        },
        {
          id: 'guidance-user',
          type: 'user_message',
          message: {
            id: 'guidance-user',
            role: 'user',
            content: 'Also inspect the files',
            runtimeGuidance: true,
            status: 'done',
            createdAt: '2026-11-02T13:45:30Z',
          },
        },
        {
          id: 'after-guidance',
          type: 'block',
          block: {
            id: 'after-guidance',
            type: 'tool',
            toolName: 'Bash',
            toolInput: { command: 'ls' },
            status: 'done',
            createdAt: 1770000001000,
          },
        },
      ],
    })
    const messages = (turnId: string) => projectRuntimeConversationTurns([buildTurn(turnId)])
    const { container, rerender } = render(
      <MessageList conversationKey="detail-scope-a" messages={messages('detail-turn-a')} />
    )
    const toolToggle = (id: string) =>
      container.querySelector<HTMLButtonElement>(
        `[data-processing-block-id="${id}"] [data-tool-detail-toggle]`
      )!
    fireEvent.click(toolToggle('after-guidance'))
    expect(toolToggle('after-guidance')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByTestId('final-processing-toggle'))
    expect(screen.getAllByTestId('processing-summary-toggle')[0]).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    fireEvent.click(screen.getAllByTestId('processing-summary-toggle')[0])
    expect(toolToggle('before-guidance')).toHaveAttribute('aria-expanded', 'false')
    expect(toolToggle('after-guidance')).toHaveAttribute('aria-expanded', 'true')

    rerender(<MessageList conversationKey="detail-scope-a" messages={messages('detail-turn-b')} />)
    expect(toolToggle('after-guidance')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
    rerender(<MessageList conversationKey="detail-scope-b" messages={messages('detail-turn-a')} />)
    expect(toolToggle('after-guidance')).toHaveAttribute('aria-expanded', 'false')
    rerender(<MessageList conversationKey="detail-scope-a" messages={messages('detail-turn-a')} />)
    expect(toolToggle('after-guidance')).toHaveAttribute('aria-expanded', 'true')
    expect(toolToggle('before-guidance')).toHaveAttribute('aria-expanded', 'false')

    const completedTurn = buildTurn('detail-turn-a')
    completedTurn.status = 'done'
    completedTurn.items.push({
      id: 'guidance-final-text',
      type: 'assistant_text',
      content: 'Both tools have completed.',
      createdAt: '2026-11-02T13:45:32Z',
    })
    rerender(
      <MessageList
        conversationKey="detail-scope-a"
        messages={projectRuntimeConversationTurns([completedTurn])}
      />
    )
    fireEvent.click(toolToggle('after-guidance'))
    const summaries = screen.getAllByTestId('processing-summary-toggle')
    expect(summaries[0]).toHaveAttribute('aria-expanded', 'true')
    expect(summaries[1]).toHaveAttribute('aria-expanded', 'false')
  })

  test('keeps an expanded file change open while final text streams and after completion', () => {
    const fileChangesBlock: ProcessingBlock = {
      id: 'file-changes-persistence',
      subtaskId: 1,
      type: 'file_changes',
      status: 'done',
      createdAt: 1770000000000,
      fileChanges: {
        version: 1,
        status: 'active',
        artifact_id: 'artifact-file-changes-persistence',
        device_id: 'device-1',
        workspace_path: '/workspace/project',
        file_count: 1,
        additions: 1,
        deletions: 1,
        files: [
          {
            path: 'scripts/env',
            change_type: 'modified',
            additions: 1,
            deletions: 1,
            binary: false,
          },
        ],
        reverted_at: null,
        revertible: false,
        diff: [
          'diff --git a/scripts/env b/scripts/env',
          '--- a/scripts/env',
          '+++ b/scripts/env',
          '@@ -1 +1 @@',
          '-OLD_ENV=remote',
          '+OLD_ENV=local',
        ].join('\n'),
      },
    }
    const message = {
      id: 'assistant-file-changes-persistence',
      role: 'assistant' as const,
      content: '',
      status: 'streaming' as const,
      createdAt: '2026-05-25T18:46:00.000+08:00',
      blocks: [fileChangesBlock],
    }
    const { rerender } = render(<MessageList messages={[message]} />)

    fireEvent.click(screen.getByRole('button', { name: /编辑 env/ }))
    expect(screen.getByTestId('process-file-change-diff')).toBeInTheDocument()

    rerender(
      <MessageList
        messages={[
          {
            ...message,
            content: 'Updated the environment configuration.',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('process-file-change-diff')).toBeInTheDocument()

    rerender(
      <MessageList
        messages={[
          {
            ...message,
            content: 'Updated the environment configuration.',
            status: 'done',
          },
        ]}
      />
    )

    expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('process-file-change-diff')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /编辑 env/ }))

    expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  test('renders retry card for failed assistant messages without error details', async () => {
    const user = userEvent.setup()
    const onRetryFailedMessage = vi.fn()

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'failed',
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
        onRetryFailedMessage={onRetryFailedMessage}
      />
    )

    expect(screen.getByTestId('assistant-error-card')).toBeInTheDocument()
    expect(screen.getByText('消息生成失败')).toBeInTheDocument()
    expect(screen.getByText('请求未能完成。你可以稍后重试。')).toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-details-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-details')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('assistant-error-retry'))

    expect(onRetryFailedMessage).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))
    expect(screen.getByTestId('assistant-error-card')).toBeInTheDocument()
  })

  test('classifies hidden raw failed content before generic task status errors', () => {
    const rawError =
      'API Error: 400 {"error":{"message":"模型 deepseek-v3.1 不支持 Anthropic 协议, model_id: ali-deepseek-v3.1"}}'

    const { container } = render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: rawError,
            status: 'failed',
            error: 'Task failed with status: FAILED',
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
      />
    )

    expect(container.querySelector('.assistant-markdown')).not.toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-card')).toHaveTextContent('模型与当前运行协议不匹配')
    expect(
      screen.getByText('ali-deepseek-v3.1 不支持当前运行协议。请切换兼容模型后重试。')
    ).toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-details')).toHaveTextContent(rawError)
  })

  test('expands raw error details from the compact details row', async () => {
    const user = userEvent.setup()
    const rawError = 'Task failed with status: FAILED'

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'failed',
            error: rawError,
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
      />
    )

    await user.click(screen.getByTestId('assistant-error-details-toggle'))

    expect(screen.getByTestId('assistant-error-details-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('assistant-error-details')).toHaveClass('whitespace-pre-wrap')
  })

  test('calls retry and switch-model handlers from failed assistant actions', async () => {
    const user = userEvent.setup()
    const onRetryFailedMessage = vi.fn()
    const onSwitchModelForFailedMessage = vi.fn()

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'failed',
            error: 'Task failed with status: FAILED',
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
        onRetryFailedMessage={onRetryFailedMessage}
        onSwitchModelForFailedMessage={onSwitchModelForFailedMessage}
      />
    )

    await user.click(screen.getByTestId('assistant-error-switch-model-retry'))
    await user.click(screen.getByTestId('assistant-error-retry'))

    expect(onRetryFailedMessage).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))
    expect(onSwitchModelForFailedMessage).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))
    expect(screen.getByTestId('assistant-error-card')).toBeInTheDocument()
  })

  test('opens referenced conversations from user messages', () => {
    const href =
      'wework-conversation://%7B%22deviceId%22%3A%22local-device%22%2C%22taskId%22%3A%22runtime-42%22%7D'
    render(
      <MessageList
        messages={[
          {
            id: 'conversation-reference',
            role: 'user',
            content: `[$修复登录流程](${href}) 继续分析`,
            status: 'done',
            createdAt: '2026-07-27T00:00:00.000Z',
          },
        ]}
      />
    )

    const conversationLink = screen.getByTestId(/^sent-conversation-token-/)
    expect(conversationLink).toHaveAttribute('href', href)
    expect(conversationLink).toHaveAttribute('aria-disabled', 'false')
    const removeHandler = installExternalLinkHandler()
    try {
      fireEvent.click(conversationLink)
      expect(`${window.location.pathname}${window.location.search}`).toBe(
        '/runtime-tasks?deviceId=local-device&taskId=runtime-42'
      )
    } finally {
      removeHandler()
      window.history.replaceState({}, '', '/')
    }
  })

  test('opens referenced issues from user messages', () => {
    const href = 'wework-issue://2753648597973755964/WEWORK2D8526-113'
    render(
      <MessageList
        messages={[
          {
            id: 'issue-reference',
            role: 'user',
            content: `[$#113 输出框里用at引用对话](${href}) [$修复登录流程](wework-conversation://%7B%22deviceId%22%3A%22local-device%22%2C%22taskId%22%3A%22runtime-42%22%7D)`,
            status: 'done',
            createdAt: '2026-11-06T02:56:00.000Z',
          },
        ]}
      />
    )

    const issueLink = screen.getByTestId(/^sent-issue-token-/)
    expect(issueLink).toHaveAttribute('href', href)
    expect(issueLink).toHaveAttribute('aria-disabled', 'false')
    const removeHandler = installExternalLinkHandler()
    try {
      fireEvent.click(issueLink)
      expect(`${window.location.pathname}${window.location.search}`).toBe(
        '/todo?projectStore=backend&projectId=2753648597973755964&itemId=WEWORK2D8526-113'
      )
    } finally {
      removeHandler()
      window.history.replaceState({}, '', '/')
    }
  })
})

function selectText(container: HTMLElement, text: string) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node && !node.textContent?.includes(text)) node = walker.nextNode()
  if (!node) throw new Error(`Could not find text: ${text}`)
  const start = node.textContent!.indexOf(text)
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, start + text.length)
  setDocumentSelection(range)
}

function firstTextNode(container: HTMLElement): Node {
  const node = document.createTreeWalker(container, NodeFilter.SHOW_TEXT).nextNode()
  if (!node) throw new Error('Could not find a text node')
  return node
}

function setDocumentSelection(range: Range) {
  Object.defineProperty(range, 'getBoundingClientRect', {
    value: () => ({ left: 100, top: 100, width: 80, height: 20 }),
  })
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent(document, new Event('selectionchange'))
}
