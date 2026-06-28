import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Attachment } from '@/types/api'
import type { ProcessingBlock } from '@/types/workbench'
import { MessageList } from './MessageList'
import '@/i18n'

const tauriCoreMock = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`),
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}))

vi.mock('@tauri-apps/api/core', () => tauriCoreMock)

describe('MessageList', () => {
  test('marks message rows for offscreen rendering containment', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'user-contained',
            role: 'user',
            content: 'hello',
            status: 'done',
            createdAt: '2026-06-11T10:00:00Z',
          },
          {
            id: 'assistant-contained',
            role: 'assistant',
            content: 'world',
            status: 'done',
            createdAt: '2026-06-11T10:00:01Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-user').className).toContain('[content-visibility:auto]')
    expect(screen.getByTestId('message-assistant').className).toContain('[content-visibility:auto]')
  })

  test('renders one assistant turn file changes under its message', () => {
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
            id: 'assistant-21',
            turnId: 21,
            role: 'assistant',
            content: 'Done',
            status: 'done',
            createdAt: '2026-06-11T10:00:00Z',
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

    expect(screen.getByTestId('file-changes-card')).toHaveTextContent('已编辑 main.ts')
    expect(screen.getByTestId('file-changes-card')).toHaveTextContent('查看更改')
  })

  test('renders cancelled assistant turns like stopped Codex turns', () => {
    const commandBlock: ProcessingBlock = {
      id: 'call-1',
      turnId: 21,
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
            turnId: 21,
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
    expect(screen.getByTestId('processing-activity-group-toggle')).toHaveTextContent(
      '已运行 1 条命令'
    )
    expect(screen.getByTestId('file-changes-card')).toHaveTextContent('已编辑 main.ts')
    expect(screen.getByTestId('assistant-stopped-notice')).toHaveTextContent('你在 9m 18s 后停止了')
  })

  test('shows stopped duration from completed time and keeps partial assistant content', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-stopped-with-content',
            role: 'assistant',
            content: '停止前已经生成的内容。',
            status: 'done',
            runtimeStatus: 'cancelled',
            createdAt: '2026-06-11T10:00:00Z',
            completedAt: '2026-06-11T10:02:12Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('assistant-stopped-notice')).toHaveTextContent('你在 2m 12s 后停止了')
    expect(screen.getByText('停止前已经生成的内容。')).toBeInTheDocument()
    expect(screen.queryByText(/已处理/)).not.toBeInTheDocument()
  })

  test('renders stopped assistant process text and activity rows in original order', () => {
    const blocks: ProcessingBlock[] = [
      {
        id: 'process-1',
        turnId: 21,
        type: 'text',
        content: '我先看你提到的 package.json。',
        status: 'done',
        createdAt: Date.parse('2026-06-11T10:00:10Z'),
      },
      {
        id: 'call-1',
        turnId: 21,
        type: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'cat package.json' },
        status: 'done',
        createdAt: Date.parse('2026-06-11T10:00:20Z'),
      },
      {
        id: 'process-2',
        turnId: 21,
        type: 'text',
        content: '从常用目录看，可能的前端仓库很多。',
        status: 'done',
        createdAt: Date.parse('2026-06-11T10:00:30Z'),
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-stopped-interleaved',
            role: 'assistant',
            content: '',
            status: 'done',
            runtimeStatus: 'cancelled',
            createdAt: '2026-06-11T10:00:00Z',
            completedAt: '2026-06-11T10:02:12Z',
            blocks,
          },
        ]}
      />
    )

    const firstText = screen.getByText('我先看你提到的 package.json。')
    const activityRow = screen.getByTestId('processing-activity-group-toggle')
    const secondText = screen.getByText('从常用目录看，可能的前端仓库很多。')

    expect(screen.getByTestId('assistant-stopped-notice')).toHaveTextContent('你在 2m 12s 后停止了')
    expect(activityRow).toHaveTextContent('已读取 1 个文件')
    expect(firstText.compareDocumentPosition(activityRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(activityRow.compareDocumentPosition(secondText) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(screen.queryByText(/已处理/)).not.toBeInTheDocument()
  })

  test('shows one stopped notice for split stopped assistant turns and keeps guidance visible', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-stopped-first',
            role: 'assistant',
            content: '',
            status: 'done',
            runtimeStatus: 'cancelled',
            stoppedNotice: true,
            createdAt: '2026-06-11T10:00:00Z',
            completedAt: '2026-06-11T10:02:12Z',
            blocks: [
              {
                id: 'process-1',
                turnId: 21,
                type: 'text',
                content: '我先看 package.json。',
                status: 'done',
                createdAt: Date.parse('2026-06-11T10:00:10Z'),
              },
            ],
          },
          {
            id: 'user-guidance',
            role: 'user',
            content: 'pnpm-lock.yaml',
            status: 'done',
            createdAt: '2026-06-11T10:01:00Z',
          },
          {
            id: 'assistant-stopped-continuation',
            role: 'assistant',
            content: '',
            status: 'done',
            runtimeStatus: 'cancelled',
            stoppedNotice: false,
            createdAt: '2026-06-11T10:00:00Z',
            completedAt: '2026-06-11T10:02:12Z',
            blocks: [
              {
                id: 'guidance-1',
                turnId: 21,
                type: 'tool',
                toolName: 'conversation_guidance',
                toolInput: { message: 'pnpm-lock.yaml' },
                status: 'done',
                createdAt: Date.parse('2026-06-11T10:01:00Z'),
              },
              {
                id: 'process-2',
                turnId: 21,
                type: 'text',
                content: '我会继续看 lockfile。',
                status: 'done',
                createdAt: Date.parse('2026-06-11T10:01:05Z'),
              },
            ],
          },
        ]}
      />
    )

    expect(screen.getAllByTestId('assistant-stopped-notice')).toHaveLength(1)
    expect(screen.getByText('我先看 package.json。')).toBeInTheDocument()
    expect(screen.getByText('pnpm-lock.yaml')).toBeInTheDocument()
    expect(screen.getByText('已引导对话')).toBeInTheDocument()
    expect(screen.getByText('我会继续看 lockfile。')).toBeInTheDocument()
  })

  test('keeps cancelled assistant turns even when no processing blocks were persisted', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-stopped-empty',
            role: 'assistant',
            content: '',
            status: 'done',
            runtimeStatus: 'cancelled',
            createdAt: '2026-06-11T10:00:00Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('assistant-stopped-notice')).toHaveTextContent('你在 0s 后停止了')
  })

  test('uses compact spacing between messages and hover actions', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'user-1',
            role: 'user',
            content: 'First message',
            status: 'done',
            createdAt: '2026-06-10T08:00:00Z',
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Second message',
            status: 'done',
            createdAt: '2026-06-10T08:01:00Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-user').parentElement).toHaveClass('gap-4')
    expect(screen.getByTestId('message-user').parentElement).toHaveClass('pt-11', 'pb-2')
    expect(screen.getAllByTestId('message-hover-actions')[0]).toHaveClass('min-h-5')
  })

  const originalCreateObjectUrl = URL.createObjectURL
  const originalRevokeObjectUrl = URL.revokeObjectURL

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    tauriCoreMock.convertFileSrc = vi.fn(
      (path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`
    )
    tauriCoreMock.invoke = vi.fn()
    tauriCoreMock.isTauri = vi.fn(() => false)
    localStorage.clear()
    URL.createObjectURL = originalCreateObjectUrl
    URL.revokeObjectURL = originalRevokeObjectUrl
    delete (navigator as unknown as { clipboard?: Clipboard }).clipboard
  })

  function stubClipboardWriteText(writeText: ReturnType<typeof vi.fn>) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  }

  test('renders user and assistant messages', () => {
    const { container } = render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '你好',
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
          },
          {
            id: '2',
            role: 'assistant',
            content: '你好，我在。',
            status: 'done',
            createdAt: '2026-05-25T00:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByText('你好')).toBeInTheDocument()
    expect(screen.getByText('你好，我在。')).toBeInTheDocument()
    expect(container.firstElementChild).toHaveClass('min-w-0', 'overflow-x-hidden')
  })

  test('does not render blank completed assistant placeholders', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'user-1',
            role: 'user',
            content: '执行pwd',
            status: 'done',
            createdAt: '2026-06-24T08:00:00.000Z',
          },
          {
            id: 'assistant-empty',
            role: 'assistant',
            content: '',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
          },
          {
            id: 'user-2',
            role: 'user',
            content: '执行ls',
            status: 'done',
            createdAt: '2026-06-24T08:00:02.000Z',
          },
          {
            id: 'assistant-2',
            role: 'assistant',
            content: 'ls output',
            status: 'done',
            createdAt: '2026-06-24T08:00:03.000Z',
          },
        ]}
      />
    )

    expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
    expect(screen.getByText('执行pwd')).toBeInTheDocument()
    expect(screen.getByText('执行ls')).toBeInTheDocument()
    expect(screen.getByText('ls output')).toBeInTheDocument()
  })

  test('keeps completed assistant turns that only have processing blocks', () => {
    const blocks: ProcessingBlock[] = [
      {
        id: 'thinking-1',
        turnId: 11,
        type: 'thinking',
        content: '正在执行 pwd',
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
            content: '',
            status: 'done',
            blocks,
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-assistant')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
    fireEvent.click(screen.getByTestId('thinking-toggle-button'))
    expect(screen.getByText('正在执行 pwd')).toBeInTheDocument()
  })

  test('keeps completed process text collapsed when the assistant has final content', () => {
    const blocks: ProcessingBlock[] = [
      {
        id: 'process-1',
        turnId: 11,
        type: 'text',
        content: '我会先看这个 skill 当前的流程结构和相关记忆。',
        status: 'done',
        createdAt: 1770000000000,
      },
      {
        id: 'tool-1',
        turnId: 11,
        type: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'rg -n workflow' },
        toolOutput: 'ok',
        status: 'done',
        createdAt: 1770000001000,
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-with-process',
            role: 'assistant',
            content: '最终建议放在 PR flow 里。',
            status: 'done',
            blocks,
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByText('最终建议放在 PR flow 里。')).toBeInTheDocument()
    expect(
      screen
        .getByRole('button', { name: /已处理/ })
        .compareDocumentPosition(screen.getByText('最终建议放在 PR flow 里。')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    const collapseContent = screen.getByTestId('processing-collapse-content')
    expect(collapseContent).toHaveAttribute('aria-hidden', 'true')
    expect(collapseContent).toHaveClass('opacity-0')
    expect(collapseContent).toHaveStyle({ maxHeight: '0px' })

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
    expect(collapseContent).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByText('我会先看这个 skill 当前的流程结构和相关记忆。')).toBeInTheDocument()
  })

  test('collapses streaming processing as soon as final answer appears', () => {
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

    const finalAnswer = screen.getByText('这是正在流式输出的最终答案。')
    const processStatus = screen.getByRole('button', { name: /已处理/ })
    const collapseContent = screen.getByTestId('processing-collapse-content')

    expect(
      processStatus.compareDocumentPosition(finalAnswer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(processStatus).toHaveAttribute('aria-expanded', 'false')
    expect(collapseContent).toHaveAttribute('aria-hidden', 'true')

    fireEvent.click(processStatus)

    expect(processStatus).toHaveAttribute('aria-expanded', 'true')
    expect(collapseContent).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByText('正在运行 pwd')).toBeInTheDocument()
    expect(screen.queryByText('/workspace/project')).not.toBeInTheDocument()
  })

  test('renders final answer web search sources as a Codex-style source chip', async () => {
    const user = userEvent.setup()
    const openWindowMock = vi.fn()
    vi.stubGlobal('open', openWindowMock)
    const blocks: ProcessingBlock[] = [
      {
        id: 'web-search-1',
        turnId: 11,
        type: 'tool',
        toolName: 'web_search',
        toolInput: {
          type: 'search',
          query: 'site:weather.com weather today Beijing China',
        },
        status: 'done',
        createdAt: 1770000000000,
      },
      {
        id: 'web-query-url-1',
        turnId: 11,
        type: 'tool',
        toolName: 'web_search',
        toolInput: {
          type: 'search',
          query: 'https://www.weather.com/weather/today/l/Beijing+China',
        },
        status: 'done',
        createdAt: 1770000001000,
      },
      {
        id: 'web-open-1',
        turnId: 11,
        type: 'tool',
        toolName: 'web_search',
        toolInput: {
          type: 'open_page',
          url: 'https://www.weather.com/weather/today/l/Beijing+China',
        },
        status: 'done',
        createdAt: 1770000002000,
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-web-sources',
            role: 'assistant',
            content: '北京今天适合室内活动。',
            status: 'done',
            blocks,
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByText('北京今天适合室内活动。')).toBeInTheDocument()
    expect(screen.getByTestId('web-search-sources-chip')).toHaveTextContent('来源')
    expect(screen.getByTestId('web-search-source-popup')).toHaveTextContent(
      'weather.com/weather/today/l/Beijing+China'
    )
    expect(screen.getAllByTestId('web-search-source-icon').length).toBeGreaterThanOrEqual(1)

    await user.click(screen.getByTestId('web-search-source-popup-row'))

    await waitFor(() =>
      expect(openWindowMock).toHaveBeenCalledWith(
        'https://www.weather.com/weather/today/l/Beijing+China',
        '_blank',
        'noopener,noreferrer'
      )
    )
  })

  test('keeps processing expansion state scoped to each conversation', () => {
    const blocks: ProcessingBlock[] = [
      {
        id: 'tool-1',
        turnId: 11,
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

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
    expect(screen.getByTestId('processing-collapse-content')).toHaveAttribute(
      'aria-hidden',
      'false'
    )

    rerender(
      <MessageList conversationKey="conversation-b" messages={[buildMessage('assistant-b')]} />
    )

    expect(screen.getByTestId('processing-collapse-content')).toHaveAttribute('aria-hidden', 'true')

    rerender(
      <MessageList conversationKey="conversation-a" messages={[buildMessage('assistant-a')]} />
    )

    expect(screen.getByTestId('processing-collapse-content')).toHaveAttribute(
      'aria-hidden',
      'false'
    )
  })

  test('reserves enough marker gutter for multi-digit ordered lists', () => {
    const { container } = render(
      <MessageList
        messages={[
          {
            id: 'assistant-list',
            role: 'assistant',
            content: Array.from(
              { length: 12 },
              (_, index) => `${index + 1}. item ${index + 1}`
            ).join('\n'),
            status: 'done',
            createdAt: '2026-06-21T00:00:00.000Z',
          },
        ]}
      />
    )

    const orderedList = container.querySelector('.assistant-markdown ol')
    expect(orderedList).toHaveClass('pl-8')
    expect(orderedList).not.toHaveClass('pl-5')
  })

  test('renders assistant markdown links as reference-style inline links', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-link',
            role: 'assistant',
            content: '[MessageList.tsx](https://example.com/MessageList.tsx)',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    const link = screen.getByRole('link', { name: 'MessageList.tsx' })
    expect(link).toHaveClass(
      'inline-flex',
      'items-center',
      'gap-1',
      'rounded-md',
      'text-blue-600',
      'no-underline'
    )
    expect(link).not.toHaveClass('bg-blue-50')
    expect(link).not.toHaveClass('hover:bg-blue-100')
    expect(link).not.toHaveClass('ring-1')
    expect(link).not.toHaveClass('text-primary')
    expect(screen.getByTestId('assistant-markdown-link-icon')).toBeInTheDocument()
  })

  test('routes assistant file-path links to the workspace file panel', async () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <MessageList
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'assistant-file-link',
            role: 'assistant',
            content: '[managing-tasks.md](/Users/dev/repo/docs/zh/managing-tasks.md)',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    // A filesystem path must not render as a navigating anchor.
    expect(screen.queryByRole('link', { name: /managing-tasks\.md/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('assistant-markdown-link'))
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('/Users/dev/repo/docs/zh/managing-tasks.md')
  })

  test('renders assistant file link line numbers without passing them to open-file actions', async () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <MessageList
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'assistant-file-line-link',
            role: 'assistant',
            content:
              '放在 [references/github-pr-flow.md](references/github-pr-flow.md:18) 的 PR 段落。',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('assistant-markdown-link-line')).toHaveTextContent('(line 18)')
    expect(screen.getByTestId('assistant-markdown-link-tooltip')).toHaveTextContent(
      'references/github-pr-flow.md (line 18)'
    )
    expect(screen.getByTestId('assistant-markdown-link-tooltip')).toHaveClass(
      'max-w-[min(36rem,calc(100vw-3rem))]',
      'break-all'
    )
    fireEvent.click(screen.getByTestId('assistant-markdown-link'))
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('references/github-pr-flow.md')
  })

  test('routes assistant file links to the turn diff review focused on that file', async () => {
    const onOpenFileChangesReview = vi.fn()
    const onLoadFileChangesDiff = vi.fn().mockResolvedValue('')
    const onOpenWorkspaceFile = vi.fn()
    render(
      <MessageList
        onOpenFileChangesReview={onOpenFileChangesReview}
        onLoadFileChangesDiff={onLoadFileChangesDiff}
        onRevertFileChanges={vi.fn()}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'assistant-changed-file-link',
            turnId: 42,
            role: 'assistant',
            content: '[managing-tasks.md](docs/zh/user-guide/chat/managing-tasks.md)',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
            fileChanges: {
              version: 1,
              status: 'active',
              artifact_id: 'turn-42',
              device_id: 'device-1',
              workspace_path: '/workspace/project',
              file_count: 1,
              additions: 2,
              deletions: 2,
              files: [
                {
                  path: 'docs/zh/user-guide/chat/managing-tasks.md',
                  change_type: 'modified',
                  additions: 2,
                  deletions: 2,
                  binary: false,
                },
              ],
            },
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('assistant-markdown-link'))
    expect(onOpenWorkspaceFile).not.toHaveBeenCalled()
    expect(onOpenFileChangesReview).toHaveBeenCalledTimes(1)
    const request = onOpenFileChangesReview.mock.calls[0][0]
    expect(request.turnId).toBe(42)
    expect(request.focusFilePath).toBe('docs/zh/user-guide/chat/managing-tasks.md')
    expect(request.defaultFileTreeVisible).toBe(false)
    expect(onLoadFileChangesDiff).not.toHaveBeenCalled()
    await request.loadDiff()
    expect(onLoadFileChangesDiff).toHaveBeenCalledWith(42)
  })

  test('renders Codex context events, memory citations, and one-column deduped file references', async () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <MessageList
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'assistant-codex-rich',
            role: 'assistant',
            content:
              'Updated [SKILL.md](/workspace/project/SKILL.md), [github-pr-flow.md](/workspace/project/references/github-pr-flow.md:18), [paas-context.log](/workspace/project/logs/paas-context.log), and [notify_pr_ready.sh](/workspace/project/scripts/notify_pr_ready.sh).',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
            references: [
              { path: '/workspace/project/SKILL.md' },
              { path: '/workspace/project/references/github-pr-flow.md', lineStart: 18 },
              { path: '/workspace/project/SKILL.md:22' },
              { path: '/workspace/project/logs/paas-context.log' },
              { path: '/workspace/project/scripts/notify_pr_ready.sh' },
            ],
            contextEvents: [
              {
                id: 'context-1',
                type: 'context_compaction',
                status: 'done',
                createdAt: Date.parse('2026-06-24T08:00:00.000Z'),
              },
            ],
            memoryCitations: [
              {
                entries: [
                  {
                    path: 'MEMORY.md',
                    lineStart: 10,
                    lineEnd: 12,
                    note: 'repo guidance',
                  },
                ],
                threadIds: ['thread-1'],
              },
            ],
          },
        ]}
      />
    )

    expect(screen.getByTestId('codex-context-events')).toBeInTheDocument()
    expect(screen.queryByText('引用文件')).not.toBeInTheDocument()
    expect(screen.getByTestId('codex-memory-citations')).toBeInTheDocument()
    expect(screen.getByTestId('codex-reference-list')).toBeInTheDocument()
    expect(
      screen
        .getByTestId('codex-memory-citations')
        .compareDocumentPosition(screen.getByTestId('codex-reference-list')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    const referenceCards = screen.getAllByTestId('codex-reference-card')
    expect(referenceCards).toHaveLength(2)
    expect(screen.getByTestId('codex-reference-list')).not.toHaveTextContent('paas-context.log')
    expect(screen.getByTestId('codex-reference-list')).not.toHaveTextContent('notify_pr_ready.sh')
    expect(referenceCards[0]).toHaveTextContent('SKILL.md')
    expect(referenceCards[0]).toHaveTextContent('文档 · MD')
    expect(referenceCards[0]).toHaveTextContent('打开预览')
    expect(screen.getAllByTestId('codex-reference-kind-label')[0]).toHaveClass(
      'group-hover/reference-card:opacity-0'
    )
    expect(screen.getAllByTestId('codex-reference-preview-label')[0]).toHaveClass(
      'opacity-0',
      'group-hover/reference-card:opacity-100'
    )
    expect(referenceCards[1]).toHaveTextContent('github-pr-flow.md')

    await userEvent.click(referenceCards[1])
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith(
      '/workspace/project/references/github-pr-flow.md'
    )

    expect(screen.getByTestId('codex-memory-citations-toggle')).toHaveTextContent('1 条记忆引用')
    await userEvent.click(screen.getByTestId('codex-memory-citations-toggle'))
    const memoryEntry = screen.getByTestId('codex-memory-citation-entry')
    expect(memoryEntry).toHaveTextContent('MEMORY.md')
    expect(memoryEntry).toHaveTextContent('10-12 行')
    expect(memoryEntry).toHaveTextContent('repo guidance')
    expect(memoryEntry).toHaveAttribute('aria-label', '打开 MEMORY.md')
    expect(screen.getByTestId('codex-memory-citation-tooltip')).toHaveTextContent('MEMORY.md')
    expect(screen.getByTestId('codex-memory-citation-tooltip')).toHaveClass(
      'max-w-[min(28rem,calc(100vw-3rem))]',
      'break-all'
    )

    onOpenWorkspaceFile.mockClear()
    await userEvent.click(memoryEntry)
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('MEMORY.md')
  })

  test('waits until streaming finishes before rendering final answer artifacts', () => {
    render(
      <MessageList
        onOpenWorkspaceFile={vi.fn()}
        onLoadFileChangesDiff={vi.fn().mockResolvedValue('')}
        onRevertFileChanges={vi.fn()}
        messages={[
          {
            id: 'assistant-streaming-artifacts',
            subtaskId: 42,
            role: 'assistant',
            content: 'See [README.md](/workspace/project/README.md) for details.',
            status: 'streaming',
            createdAt: '2026-06-24T08:00:01.000Z',
            references: [{ path: '/workspace/project/README.md' }],
            memoryCitations: [
              {
                entries: [{ path: 'MEMORY.md', lineStart: 10, note: 'repo guidance' }],
                threadIds: ['thread-1'],
              },
            ],
            fileChanges: {
              version: 1,
              status: 'active',
              artifact_id: 'turn-42',
              device_id: 'device-1',
              workspace_path: '/workspace/project',
              file_count: 1,
              additions: 2,
              deletions: 0,
              files: [
                {
                  path: 'README.md',
                  change_type: 'modified',
                  additions: 2,
                  deletions: 0,
                  binary: false,
                },
              ],
            },
          },
        ]}
      />
    )

    expect(screen.getByText(/See/)).toBeInTheDocument()
    expect(screen.queryByTestId('codex-reference-list')).not.toBeInTheDocument()
    expect(screen.queryByTestId('codex-memory-citations')).not.toBeInTheDocument()
    expect(screen.queryByTestId('file-changes-card')).not.toBeInTheDocument()
  })

  test('adds deduped document references from turn file changes and expands hidden references', async () => {
    render(
      <MessageList
        onOpenWorkspaceFile={vi.fn()}
        onLoadFileChangesDiff={vi.fn().mockResolvedValue('')}
        onRevertFileChanges={vi.fn()}
        messages={[
          {
            id: 'assistant-file-change-documents',
            turnId: 42,
            role: 'assistant',
            content:
              'Updated [SKILL.md](/workspace/project/SKILL.md) and [wegent-merged-env.md](/workspace/project/references/wegent-merged-env.md).',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
            fileChanges: {
              version: 1,
              status: 'active',
              artifact_id: 'turn-42',
              device_id: 'device-1',
              workspace_path: '/workspace/project',
              file_count: 10,
              additions: 64,
              deletions: 130,
              files: [
                {
                  path: 'SKILL.md',
                  change_type: 'modified',
                  additions: 12,
                  deletions: 12,
                  binary: false,
                },
                {
                  path: 'scripts/run_on_integration_env.sh',
                  change_type: 'deleted',
                  additions: 0,
                  deletions: 58,
                  binary: false,
                },
                {
                  path: 'references/acceptance-validation-contract.md',
                  change_type: 'modified',
                  additions: 1,
                  deletions: 1,
                  binary: false,
                },
                {
                  path: 'references/browser-validation.md',
                  change_type: 'modified',
                  additions: 1,
                  deletions: 1,
                  binary: false,
                },
                {
                  path: 'references/github-pr-flow.md',
                  change_type: 'modified',
                  additions: 3,
                  deletions: 3,
                  binary: false,
                },
                {
                  path: 'references/post-review-follow-up.md',
                  change_type: 'modified',
                  additions: 3,
                  deletions: 9,
                  binary: false,
                },
                {
                  path: 'references/pr-review-notification.md',
                  change_type: 'modified',
                  additions: 2,
                  deletions: 2,
                  binary: false,
                },
                {
                  path: 'references/wegent-integration-test-env.md',
                  change_type: 'modified',
                  additions: 22,
                  deletions: 23,
                  binary: false,
                },
                {
                  path: 'references/wegent-merged-env.md',
                  change_type: 'modified',
                  additions: 4,
                  deletions: 4,
                  binary: false,
                },
                {
                  path: 'scripts/start_executor_local.sh',
                  change_type: 'renamed',
                  additions: 1,
                  deletions: 1,
                  binary: false,
                },
              ],
            },
          },
        ]}
      />
    )

    expect(screen.getAllByTestId('codex-reference-card')).toHaveLength(3)
    expect(screen.getByTestId('toggle-codex-reference-list-button')).toHaveTextContent(
      '显示另外 5 个'
    )

    await userEvent.click(screen.getByTestId('toggle-codex-reference-list-button'))

    const expandedReferenceCards = screen.getAllByTestId('codex-reference-card')
    expect(expandedReferenceCards).toHaveLength(8)
    expect(screen.getByTestId('toggle-codex-reference-list-button')).toHaveTextContent('收起文件')
    expect(expandedReferenceCards.map(card => card.textContent)).toEqual([
      expect.stringContaining('SKILL.md'),
      expect.stringContaining('acceptance-validation-contract.md'),
      expect.stringContaining('browser-validation.md'),
      expect.stringContaining('github-pr-flow.md'),
      expect.stringContaining('post-review-follow-up.md'),
      expect.stringContaining('pr-review-notification.md'),
      expect.stringContaining('wegent-integration-test-env.md'),
      expect.stringContaining('wegent-merged-env.md'),
    ])
  })

  test('renders IM source badge for user messages with channel label', () => {
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '来自 IM 的消息',
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
            source: {
              source: 'im',
              channel_type: 'dingtalk',
              channel_label: '钉钉',
            },
          },
        ]}
      />
    )

    const badge = screen.getByTestId('message-source-badge')
    expect(badge).toHaveTextContent('钉钉')
    expect(badge.closest('.opacity-0')).toBeNull()
    expect(screen.getByTestId('message-source-row')).toContainElement(badge)
  })

  test('renders Discord IM source badge from channel type', () => {
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: 'Message from Discord',
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
            source: {
              source: 'im',
              channel_type: 'discord',
            },
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-source-badge')).toHaveTextContent('Discord')
  })

  test('does not render IM source badge for assistant or non-IM messages', () => {
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'assistant',
            content: '助手消息',
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
            source: {
              source: 'im',
              channel_type: 'dingtalk',
              channel_label: '钉钉',
            },
          },
          {
            id: '2',
            role: 'user',
            content: '网页消息',
            status: 'done',
            createdAt: '2026-05-25T00:00:01.000Z',
            source: {
              source: 'web',
            },
          },
        ]}
      />
    )

    expect(screen.queryByTestId('message-source-badge')).not.toBeInTheDocument()
    expect(screen.queryByTestId('message-source-row')).not.toBeInTheDocument()
    expect(
      screen
        .getByText('网页消息')
        .closest('[data-testid="message-user"]')
        ?.querySelector('div.flex.min-h-5.items-center.justify-end.gap-1:not(.opacity-0)')
    ).toBeNull()
  })

  test('renders sent local skill mentions as polished inline tokens', () => {
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content:
              '[$browser](skill:///Users/crystal/.codex/skills/browser/SKILL.md) 访问一下浏览器',
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
          },
        ]}
      />
    )

    const token = screen.getByTestId('sent-local-skill-token-browser')
    expect(token).toHaveTextContent('Browser')
    expect(screen.getByTestId('sent-local-skill-icon-browser')).toBeInTheDocument()
    expect(token).toHaveClass(
      'h-7',
      'gap-1',
      'rounded-xl',
      'bg-muted',
      'text-blue-600',
      'no-underline'
    )
    expect(screen.getByTestId('sent-local-skill-icon-browser')).toHaveClass('text-blue-600')
    expect(token).not.toHaveClass(
      'border',
      'bg-background',
      'text-text-secondary',
      'shadow-[0_1px_2px_rgba(15,23,42,0.05)]'
    )
    expect(token).not.toHaveClass('bg-primary/10', 'text-primary')
  })

  test('renders image attachments in user messages', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:message-image-preview')
    URL.revokeObjectURL = vi.fn()
    localStorage.setItem('auth_token', 'token-1')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
      })
    )

    const attachment: Attachment = {
      id: 43,
      filename: 'diagram.png',
      file_size: 1024,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-25T15:08:00.000+08:00',
    }

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '分析下这个图片',
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(await screen.findByTestId('message-image-preview')).toHaveAttribute(
      'src',
      'blob:message-image-preview'
    )
    expect(screen.getByTestId('message-image-preview')).toHaveAttribute('alt', 'diagram.png')
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/attachments/43/download'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer token-1' },
      })
    )
  })

  test('uses local image attachment previews without fetching after send', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const attachment: Attachment = {
      id: 43,
      filename: 'codex-clipboard.png',
      file_size: 1024,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-25T15:08:00.000+08:00',
      local_preview_url: 'blob:local-sent-image',
    }

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '发出去图片',
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(await screen.findByTestId('message-image-preview')).toHaveAttribute(
      'src',
      'blob:local-sent-image'
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  test('renders local path image attachment previews through Tauri asset URLs', async () => {
    vi.stubGlobal('fetch', vi.fn())

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
            content: '解释一下些图片',
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-06-26T15:33:00.000+08:00',
          },
        ]}
      />
    )

    expect(await screen.findByTestId('message-image-preview')).toHaveAttribute(
      'src',
      'asset://localhost/var/folders/tmp/codex-clipboard/screenshot.png'
    )
    expect(screen.getByTestId('message-hover-region')).toHaveClass('w-full', 'max-w-full')
    expect(screen.getByTestId('user-message-content').parentElement).toHaveClass('max-w-[80%]')
    expect(screen.getByTestId('message-image-attachments')).toHaveClass(
      'justify-end',
      'overflow-visible'
    )
    expect(screen.getByTestId('message-image-attachments')).not.toHaveClass('justify-start')
    expect(screen.getByTestId('message-image-attachment-strip')).toHaveClass(
      'ml-auto',
      'justify-end'
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  test('downloads local path image attachments through the Tauri native command', async () => {
    vi.stubGlobal('fetch', vi.fn())
    tauriCoreMock.isTauri = vi.fn(() => true)
    tauriCoreMock.invoke = vi.fn().mockResolvedValue('/Users/crystal/Downloads/screenshot.png')

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
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith('download_local_file_to_downloads', {
        sourcePath: '/var/folders/tmp/codex-clipboard/screenshot.png',
        filename: 'screenshot.png',
      })
    })
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

  test('renders Codex local image file mentions as user image previews after refresh', async () => {
    render(
      <MessageList
        messages={[
          {
            id: 'codex-image-mention',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## image.png: /Users/yunpeng7/.wegent-executor/workspace/attachments/10406026969952/0/image.png',
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

    expect(await screen.findByTestId('message-local-image-preview')).toHaveAttribute(
      'src',
      'asset://localhost/Users/yunpeng7/.wegent-executor/workspace/attachments/10406026969952/0/image.png'
    )
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('分析下这个图片')
    expect(screen.queryByText(/Files mentioned by the user/)).not.toBeInTheDocument()
    expect(screen.queryByText(/My request for Codex/)).not.toBeInTheDocument()
  })

  test('renders Codex local non-image file mentions as compact file chips', () => {
    const onOpenWorkspaceFile = vi.fn()

    render(
      <MessageList
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'codex-file-mention',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## package.json: /Users/crystal/package.json',
              '',
              '## My request for Codex:',
              '看看',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-codex-file-mention')).toHaveTextContent('package.json')
    expect(screen.getByTestId('message-codex-file-braces-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('message-codex-file-document-icon')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-codex-file-mention')).toHaveAttribute(
      'title',
      '/Users/crystal/package.json'
    )
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('看看')
    expect(screen.queryByText(/Files mentioned by the user/)).not.toBeInTheDocument()
    expect(screen.queryByText(/My request for Codex/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('message-codex-file-mention'))
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('/Users/crystal/package.json')
  })

  test('renders file-only Codex mentions without the raw markdown wrapper', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'codex-file-only-mention',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## pnpm-lock.yaml: /Users/crystal/pnpm-lock.yaml',
              '',
              '## My request for Codex:',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-codex-file-mention')).toHaveTextContent('pnpm-lock.yaml')
    expect(screen.getByTestId('message-codex-file-document-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('message-codex-file-braces-icon')).not.toBeInTheDocument()
    expect(screen.queryByTestId('user-message-content')).not.toBeInTheDocument()
    expect(screen.queryByText(/Files mentioned by the user/)).not.toBeInTheDocument()
    expect(screen.queryByText(/My request for Codex/)).not.toBeInTheDocument()
  })

  test('does not render raw local image paths when Tauri file conversion is unavailable', () => {
    tauriCoreMock.convertFileSrc = undefined as unknown as typeof tauriCoreMock.convertFileSrc

    render(
      <MessageList
        messages={[
          {
            id: 'browser-codex-image-mention',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## image.png: /Users/yunpeng7/.wegent-executor/workspace/attachments/10406026969952/0/image.png',
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

    expect(screen.queryByTestId('message-local-image-preview')).not.toBeInTheDocument()
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('分析下这个图片')
  })

  test('hides Codex local image previews when the converted file URL fails to load', async () => {
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

    fireEvent.error(await screen.findByTestId('message-local-image-preview'))

    expect(screen.queryByTestId('message-local-image-preview')).not.toBeInTheDocument()
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('分析下这个图片')
  })

  test('does not create Tauri asset previews for transient Codex clipboard images', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'codex-transient-clipboard-image',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## codex-clipboard-c73483f7-dfe5-413b-a30f-787bb2814c21.png: /var/folders/fp/l62gd0z17ys57j9s7t0dfq3w0000gn/T/codex-clipboard-c73483f7-dfe5-413b-a30f-787bb2814c21.png',
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

    expect(screen.queryByTestId('message-local-image-preview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('message-codex-file-mention')).not.toBeInTheDocument()
    expect(tauriCoreMock.convertFileSrc).not.toHaveBeenCalledWith(
      expect.stringContaining('codex-clipboard-c73483f7')
    )
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('分析下这个图片')
  })

  test('renders assistant markdown attachment images through authenticated blob previews', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:assistant-markdown-image')
    URL.revokeObjectURL = vi.fn()
    localStorage.setItem('auth_token', 'token-1')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
      })
    )

    render(
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
    )

    expect(await screen.findByTestId('assistant-markdown-image')).toHaveAttribute(
      'src',
      'blob:assistant-markdown-image'
    )
    expect(screen.getByTestId('assistant-markdown-image')).toHaveAttribute('alt', 'diagram')
    expect(fetch).toHaveBeenCalledWith(
      '/api/attachments/43/download',
      expect.objectContaining({
        headers: { Authorization: 'Bearer token-1' },
      })
    )
  })

  test('renders assistant markdown local image paths through Tauri asset URLs', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-local-image',
            role: 'assistant',
            content: '生成结果：\n\n![local result](/Users/yunpeng7/Pictures/result.png)',
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.getByTestId('assistant-markdown-image')).toHaveAttribute(
      'src',
      'asset://localhost/Users/yunpeng7/Pictures/result.png'
    )
    expect(screen.getByTestId('assistant-markdown-image')).toHaveAttribute('alt', 'local result')
  })

  test('opens an enlarged preview from a user message image attachment', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:message-image-preview')
    URL.revokeObjectURL = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
      })
    )

    const attachment: Attachment = {
      id: 43,
      filename: 'diagram.png',
      file_size: 1024,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-25T15:08:00.000+08:00',
    }

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '分析下这个图片',
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    await userEvent.click(await screen.findByTestId('message-image-preview'))

    const lightbox = screen.getByTestId('attachment-image-lightbox')
    const lightboxImage = await screen.findByTestId('attachment-image-lightbox-image')

    expect(lightbox).toBeInTheDocument()
    expect(lightbox.parentElement).toBe(document.body)
    expect(lightboxImage).toHaveAttribute('src', 'blob:message-image-preview')
    expect(lightboxImage).toHaveAttribute('alt', 'diagram.png')
    expect(lightboxImage).toHaveStyle({ transform: 'scale(1)' })
    expect(screen.getByTestId('attachment-image-download')).toBeEnabled()
    expect(screen.getByTestId('attachment-image-zoom-controls')).toHaveClass('bottom-6')
    expect(screen.getByTestId('attachment-image-zoom-value')).toHaveTextContent('100%')

    await userEvent.click(screen.getByTestId('attachment-image-zoom-in'))

    expect(lightboxImage).toHaveStyle({ transform: 'scale(1.25)' })
    expect(screen.getByTestId('attachment-image-zoom-value')).toHaveTextContent('125%')
  })

  test('navigates between images in the enlarged preview gallery', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const attachments: Attachment[] = [
      {
        id: 43,
        filename: 'first.png',
        file_size: 1024,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-25T15:08:00.000+08:00',
        local_preview_url: 'blob:first-image',
      },
      {
        id: 44,
        filename: 'second.png',
        file_size: 1024,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-25T15:08:00.000+08:00',
        local_preview_url: 'blob:second-image',
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '分析下这些图片',
            status: 'done',
            attachments,
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    const previews = await screen.findAllByTestId('message-image-preview')
    await userEvent.click(previews[0])

    expect(await screen.findByTestId('attachment-image-lightbox-image')).toHaveAttribute(
      'alt',
      'first.png'
    )

    await userEvent.click(screen.getByTestId('attachment-image-next'))

    await waitFor(() => {
      expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
        'src',
        'blob:second-image'
      )
      expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
        'alt',
        'second.png'
      )
    })

    await userEvent.click(screen.getByTestId('attachment-image-previous'))

    await waitFor(() => {
      expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
        'src',
        'blob:first-image'
      )
      expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
        'alt',
        'first.png'
      )
    })
  })

  test('keeps image attachments in a single horizontal strip', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:message-image-preview')
    URL.revokeObjectURL = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
      })
    )

    const attachments: Attachment[] = [
      {
        id: 43,
        filename: 'first.png',
        file_size: 1024,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-25T15:08:00.000+08:00',
      },
      {
        id: 44,
        filename: 'second.png',
        file_size: 1024,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-25T15:08:00.000+08:00',
      },
      {
        id: 45,
        filename: 'third.png',
        file_size: 1024,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-25T15:08:00.000+08:00',
      },
      {
        id: 46,
        filename: 'fourth.png',
        file_size: 1024,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-25T15:08:00.000+08:00',
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '',
            status: 'done',
            attachments,
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    const previews = await screen.findAllByTestId('message-image-preview')

    expect(previews).toHaveLength(4)
    expect(screen.getByTestId('message-image-attachments')).toHaveClass(
      'w-full',
      'flex-row',
      'flex-nowrap',
      'overflow-x-auto',
      'scrollbar-none'
    )
    expect(screen.getByTestId('message-image-attachment-strip')).toHaveClass(
      'ml-auto',
      'w-max',
      'flex-nowrap',
      'justify-end'
    )
    expect(screen.getByTestId('message-image-attachments')).not.toHaveClass('justify-start')
    expect(screen.getByTestId('message-image-attachments')).not.toHaveClass('flex-wrap')
    expect(screen.getByTestId('message-hover-region')).toHaveClass('w-full', 'max-w-full')
    expect(previews[0]).toHaveClass('h-20', 'w-20', 'shrink-0', 'rounded-xl', 'object-cover')
  })

  test('renders document attachments in user messages', () => {
    const attachment: Attachment = {
      id: 44,
      filename: 'requirements.pdf',
      file_size: 2048,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: '.pdf',
      created_at: '2026-05-25T15:09:00.000+08:00',
    }

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '分析下文档',
            status: 'done',
            attachments: [attachment],
            createdAt: '2026-05-25T15:09:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-document-attachment')).toHaveTextContent('requirements.pdf')
    expect(screen.getByTestId('message-document-attachment')).toHaveTextContent('PDF')
  })

  test('shows user message hover actions with time, copy label, and resettable success icon', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-25T16:00:00.000+08:00'))

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '对 bind_shell=openclaw 直接跳过',
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    const hoverRegion = screen.getByTestId('message-hover-region')
    const hoverActions = screen.getByTestId('message-hover-actions')
    expect(hoverActions).toHaveClass('opacity-0', 'pointer-events-none')
    expect(hoverActions).not.toHaveClass(
      'group-hover/message:opacity-100',
      'group-focus-within/message:opacity-100'
    )
    expect(hoverRegion).toHaveClass('max-w-[80%]')

    fireEvent.pointerEnter(hoverRegion)
    expect(hoverActions).toHaveClass('opacity-100', 'pointer-events-auto')

    expect(screen.getByTestId('message-hover-time')).toHaveTextContent('15:08')
    expect(screen.getByTestId('message-hover-time')).not.toHaveClass('opacity-0')
    expect(screen.getByTestId('message-hover-time')).toHaveClass('select-text')
    expect(screen.getByTestId('message-hover-time')).not.toHaveClass('pointer-events-none')
    expect(screen.getByTestId('copy-message-label')).toHaveTextContent('复制')
    expect(screen.getByTestId('copy-message-label')).toHaveClass(
      'opacity-0',
      'group-hover/copy:opacity-100'
    )
    expect(screen.getByTestId('copy-message-label')).not.toHaveClass(
      'group-focus-within/copy:opacity-100'
    )
    expect(screen.getByTestId('copy-message-icon')).toBeInTheDocument()

    vi.useRealTimers()

    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboardWriteText(writeText)

    const copyButton = screen.getByTestId('copy-message-button')
    expect(copyButton).toHaveAttribute('title', '复制')
    expect(copyButton).not.toHaveClass('opacity-0')

    await userEvent.click(copyButton)

    expect(writeText).toHaveBeenCalledWith('对 bind_shell=openclaw 直接跳过')
    expect(await screen.findByTestId('copy-message-success-icon')).toBeInTheDocument()
    expect(copyButton).toHaveClass('bg-text-primary', 'text-background/70')

    fireEvent.mouseLeave(hoverActions)
    fireEvent.pointerLeave(hoverRegion)
    expect(hoverActions).toHaveClass('opacity-0', 'pointer-events-none')
    expect(screen.getByTestId('copy-message-success-icon')).toBeInTheDocument()
    fireEvent.transitionEnd(screen.getByTestId('copy-message-label'), { propertyName: 'opacity' })
    expect(screen.getByTestId('copy-message-success-icon')).toBeInTheDocument()
    fireEvent.transitionEnd(hoverActions, { propertyName: 'opacity' })
    expect(screen.getByTestId('copy-message-icon')).toBeInTheDocument()
  })

  test('collapses long user messages without changing copied content', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboardWriteText(writeText)
    const content = Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 行内容`).join('\n')

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content,
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    const messageContent = screen.getByTestId('user-message-content')
    const toggleButton = screen.getByTestId('toggle-user-message-button')

    expect(messageContent).toHaveClass('max-h-44', 'overflow-hidden')
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false')
    expect(toggleButton).toHaveTextContent('展开')

    await userEvent.click(toggleButton)

    expect(messageContent).not.toHaveClass('max-h-44')
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true')
    expect(toggleButton).toHaveTextContent('收起')

    const hoverRegion = screen.getByTestId('message-hover-region')
    expect(hoverRegion).toHaveClass('max-w-[80%]')
    fireEvent.pointerEnter(hoverRegion)

    await userEvent.click(screen.getByTestId('copy-message-button'))
    expect(writeText).toHaveBeenCalledWith(content)
  })

  test('does not show a collapse control for short user messages', () => {
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '短消息',
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('toggle-user-message-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('user-message-content')).not.toHaveClass('max-h-44')
  })

  test('shows only clock time for messages created today', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-05-25T18:50:00.000+08:00'))

      render(
        <MessageList
          messages={[
            {
              id: '1',
              role: 'user',
              content: '今天的消息',
              status: 'done',
              createdAt: '2026-05-25T18:49:00.000+08:00',
            },
          ]}
        />
      )

      expect(screen.getByTestId('message-hover-time')).toHaveTextContent('18:49')
      expect(screen.getByTestId('message-hover-time')).not.toHaveTextContent('Mon')
    } finally {
      vi.useRealTimers()
    }
  })

  test('shows weekday and clock time for messages created within seven days', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-06-29T18:50:00.000+08:00'))

      render(
        <MessageList
          messages={[
            {
              id: '1',
              role: 'user',
              content: '昨天的消息',
              status: 'done',
              createdAt: '2026-06-28T15:27:00.000+08:00',
            },
          ]}
        />
      )

      expect(screen.getByTestId('message-hover-time')).toHaveTextContent('星期日15:27')
    } finally {
      vi.useRealTimers()
    }
  })

  test('shows date and clock time for messages not created today in the current year', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-05-25T18:50:00.000+08:00'))

      render(
        <MessageList
          messages={[
            {
              id: '1',
              role: 'user',
              content: '昨天的消息',
              status: 'done',
              createdAt: '2026-06-18T12:04:00.000+08:00',
            },
          ]}
        />
      )

      expect(screen.getByTestId('message-hover-time')).toHaveTextContent('6月18日 12:04')
    } finally {
      vi.useRealTimers()
    }
  })

  test('shows year for messages not created this year', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-05-25T18:50:00.000+08:00'))

      render(
        <MessageList
          messages={[
            {
              id: '1',
              role: 'user',
              content: '去年的消息',
              status: 'done',
              createdAt: '2025-06-18T12:04:00.000+08:00',
            },
          ]}
        />
      )

      expect(screen.getByTestId('message-hover-time')).toHaveTextContent('2025年6月18日 12:04')
    } finally {
      vi.useRealTimers()
    }
  })

  test('shows assistant message hover actions with time and icon-hover copy label', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-25T19:00:00.000+08:00'))

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '好的，以下是作文内容。',
            status: 'done',
            createdAt: '2026-05-25T18:38:00.000+08:00',
          },
        ]}
      />
    )

    const hoverRegion = screen.getByTestId('message-hover-region')
    const hoverActions = screen.getByTestId('message-hover-actions')
    expect(hoverActions).toHaveClass('opacity-0', 'pointer-events-none')
    expect(hoverActions).not.toHaveClass(
      'group-hover/message:opacity-100',
      'group-focus-within/message:opacity-100'
    )
    expect(hoverRegion).toHaveClass('w-full', 'max-w-full')

    fireEvent.pointerEnter(hoverRegion)
    expect(hoverActions).toHaveClass('opacity-100', 'pointer-events-auto')

    expect(screen.getByTestId('message-hover-time')).toHaveTextContent('18:38')
    expect(screen.getByTestId('message-hover-time')).not.toHaveClass('opacity-0')
    expect(screen.getByTestId('message-hover-time')).toHaveClass('select-text')
    expect(screen.getByTestId('message-hover-time')).not.toHaveClass('pointer-events-none')
    expect(screen.getByTestId('copy-message-label')).toHaveTextContent('复制')
    expect(screen.getByTestId('copy-message-label')).toHaveClass(
      'opacity-0',
      'group-hover/copy:opacity-100'
    )
    expect(screen.getByTestId('copy-message-label')).not.toHaveClass(
      'group-focus-within/copy:opacity-100'
    )

    vi.useRealTimers()

    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboardWriteText(writeText)

    const copyButton = screen.getByTestId('copy-message-button')
    expect(copyButton).toHaveAttribute('title', '复制')
    expect(copyButton).not.toHaveClass('opacity-0')

    await userEvent.click(copyButton)

    expect(writeText).toHaveBeenCalledWith('好的，以下是作文内容。')
  })

  test('hides assistant hover actions while the response is streaming', () => {
    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '我正在处理你的请求。',
            status: 'streaming',
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('message-hover-time')).not.toBeInTheDocument()
    expect(screen.queryByTestId('copy-message-button')).not.toBeInTheDocument()
    expect(screen.queryByText('正在思考')).not.toBeInTheDocument()
  })

  test('renders only thinking before the first streamed response arrives', () => {
    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.queryByText(/已处理/)).not.toBeInTheDocument()
    const thinkingIndicator = screen.getByTestId('thinking-indicator')
    expect(thinkingIndicator).toHaveTextContent('正在思考')
    expect(thinkingIndicator).not.toHaveClass('bg-surface')
    expect(screen.getByText('正在思考')).toHaveClass('waiting-thinking-text')
  })

  test('shows full-width processing status once final text starts streaming', () => {
    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '我先',
            status: 'streaming',
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
      />
    )

    const status = screen.getByText('已处理 1 秒')

    expect(screen.queryByText('正在思考')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /已处理/ })).not.toBeInTheDocument()
    expect(status.parentElement).toHaveClass('w-full', 'border-b')
    expect(screen.getByTestId('message-hover-region')).toHaveClass('w-full', 'max-w-full')
  })

  test('starts the live processing timer when the first visible response appears', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-05-25T18:46:08.000+08:00'))

      render(
        <MessageList
          messages={[
            {
              id: '2',
              role: 'assistant',
              content: '我先',
              status: 'streaming',
              createdAt: '2026-05-25T18:46:00.000+08:00',
            },
          ]}
        />
      )

      expect(screen.getByText('已处理 1 秒')).toBeInTheDocument()
      expect(screen.queryByText('已处理 8 秒')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  test('shows thinking in the message list while waiting for the assistant response', () => {
    render(
      <MessageList
        isWaitingForAssistant
        messages={[
          {
            id: '1',
            role: 'user',
            content: 'hi',
            status: 'done',
            createdAt: '2026-05-25T18:45:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.queryByText(/已处理/)).not.toBeInTheDocument()
    const thinkingIndicator = screen.getByTestId('thinking-indicator')
    expect(thinkingIndicator).toHaveTextContent('正在思考')
    expect(thinkingIndicator).not.toHaveClass('bg-surface')
    expect(screen.getByText('正在思考')).toHaveClass('waiting-thinking-text')
  })

  test('uses running tool rows instead of a generic thinking indicator when blocks are visible', () => {
    const runningBlock: ProcessingBlock = {
      id: 'call-1',
      turnId: 1,
      type: 'tool',
      toolName: 'Bash',
      toolInput: { command: 'rg -n "foo" src' },
      status: 'streaming',
      createdAt: 1770000000000,
    }

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: 'Let me explore the repo structure for you.',
            status: 'streaming',
            createdAt: '2026-05-25T18:46:00.000+08:00',
            blocks: [runningBlock],
          },
        ]}
      />
    )

    expect(screen.queryByText('正在思考')).not.toBeInTheDocument()
    expect(screen.getByText('正在运行 rg -n "foo" src')).toBeInTheDocument()
  })

  test('renders process text inside the processing timeline before the following tool', () => {
    const processBlock: ProcessingBlock = {
      id: 'text-1',
      turnId: 1,
      type: 'text',
      content: 'Let me explore the repository structure.',
      status: 'done',
      createdAt: 1770000000000,
    }
    const runningBlock: ProcessingBlock = {
      id: 'call-1',
      turnId: 1,
      type: 'tool',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      status: 'streaming',
      createdAt: 1770000000001,
    }

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-05-25T18:46:00.000+08:00',
            blocks: [processBlock, runningBlock],
          },
        ]}
      />
    )

    const processText = screen.getByTestId('process-text-block')
    const runningTool = screen.getByText(/正在运行 ls/)

    expect(processText.compareDocumentPosition(runningTool)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  test('keeps process text even when it matches the final assistant content', () => {
    const finalTextBlock: ProcessingBlock = {
      id: 'text-final',
      turnId: 1,
      type: 'text',
      content: '这是最终回答。',
      status: 'done',
      createdAt: 1770000000000,
    }

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '这是最终回答。',
            status: 'done',
            createdAt: '2026-05-25T18:46:00.000+08:00',
            blocks: [finalTextBlock],
          },
        ]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByTestId('process-text-block')).toHaveTextContent('这是最终回答。')
    expect(screen.getAllByText('这是最终回答。')).toHaveLength(2)
  })

  test('renders failed assistant messages in the approved error-card layout', () => {
    const rawError =
      'API Error: 400 {"error":{"message":"模型 deepseek-v3.1 不支持 Anthropic 协议, model_id: ali-deepseek-v3.1"}}'

    const { container } = render(
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

    const errorCard = screen.getByTestId('assistant-error-card')
    expect(errorCard).toBeInTheDocument()
    expect(errorCard).toHaveClass('w-[min(546px,100%)]', 'rounded-[14px]')
    expect(screen.getByText('模型与当前运行协议不匹配')).toBeInTheDocument()
    expect(screen.getByText('切换模型并重试')).toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-switch-model-retry')).toHaveClass(
      'bg-text-primary',
      'text-background'
    )
    expect(screen.getByTestId('assistant-error-switch-model-retry')).not.toHaveClass(
      'bg-primary',
      'text-bg-base'
    )
    expect(screen.getByText('重试')).toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-details-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.getByTestId('assistant-error-details')).toHaveTextContent(rawError)
    expect(screen.getByTestId('assistant-error-details')).toHaveClass('truncate')
    expect(container.querySelector('.assistant-markdown')).not.toBeInTheDocument()
    expect(screen.queryByText(rawError, { selector: 'p.text-red-500' })).not.toBeInTheDocument()
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

    await user.click(screen.getByTestId('assistant-error-retry'))
    await user.click(screen.getByTestId('assistant-error-switch-model-retry'))

    expect(onRetryFailedMessage).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))
    expect(onSwitchModelForFailedMessage).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))
  })

  test('uses backend error type before raw error text when rendering failed messages', () => {
    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'failed',
            error: 'network down',
            errorType: 'rate_limit',
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.getByText('请求过于频繁，请稍后再试')).toBeInTheDocument()
    expect(screen.queryByText('网络连接失败：请检查网络连接后重试')).not.toBeInTheDocument()
  })

  test('keeps regular long content inside the page while tables and highlighted code scroll locally', () => {
    const longToken = 'a'.repeat(120)
    const { container } = render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: longToken,
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
          },
          {
            id: '2',
            role: 'assistant',
            content: [
              `https://example.com/${longToken}`,
              '',
              '| 超长列 |',
              '| --- |',
              `| ${longToken} |`,
              '',
              '```css',
              `.collapsible { color: ${longToken}; }`,
              '```',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-05-25T00:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-user')).toHaveClass('overflow-x-hidden')
    expect(screen.getByTestId('message-assistant')).toHaveClass('overflow-x-hidden')
    expect(container.querySelector('.assistant-markdown')).toHaveClass(
      'break-words',
      'overflow-x-hidden'
    )
    expect(container.querySelector('table')?.parentElement).toHaveClass(
      'overflow-x-auto',
      'max-w-full'
    )
    expect(screen.getByTestId('markdown-code-block')).toHaveTextContent('.collapsible')
    expect(screen.getByTestId('markdown-code-block-language')).toHaveTextContent('css')
    expect(screen.getByTestId('markdown-code-block')).toHaveClass('overflow-hidden')
  })

  test('renders local skill markdown links in user messages', () => {
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content:
              'hello [$env-context](skill:///Users/crystal/.codex/skills/env-context/SKILL.md) context',
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
          },
        ]}
      />
    )

    const skillLink = screen.getByTestId('sent-local-skill-token-env-context')

    expect(skillLink).toHaveAttribute(
      'href',
      'skill:///Users/crystal/.codex/skills/env-context/SKILL.md'
    )
    expect(screen.getByTestId('message-user')).toHaveTextContent('hello Env Context context')
  })
})
