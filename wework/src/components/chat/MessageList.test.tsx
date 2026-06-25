import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Attachment } from '@/types/api'
import type { ProcessingBlock } from '@/types/workbench'
import { MessageList } from './MessageList'
import '@/i18n'

const tauriCoreMock = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`),
}))

vi.mock('@tauri-apps/api/core', () => tauriCoreMock)

describe('MessageList', () => {
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
            subtaskId: 21,
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

    expect(screen.getByTestId('file-changes-card')).toHaveTextContent('src/main.ts')
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
    expect(screen.getByTestId('processing-activity-group-toggle')).toHaveTextContent(
      '已运行 1 条命令'
    )
    expect(screen.getByTestId('file-changes-card')).toHaveTextContent('src/main.ts')
    expect(screen.getByTestId('assistant-stopped-notice')).toHaveTextContent('你在 9m 18s 后停止了')
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
    expect(screen.getAllByTestId('message-hover-time')[0].parentElement).toHaveClass('min-h-5')
  })

  const originalCreateObjectUrl = URL.createObjectURL
  const originalRevokeObjectUrl = URL.revokeObjectURL

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    tauriCoreMock.convertFileSrc = vi.fn(
      (path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`
    )
    localStorage.clear()
    URL.createObjectURL = originalCreateObjectUrl
    URL.revokeObjectURL = originalRevokeObjectUrl
  })

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
        subtaskId: 11,
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
    await userEvent.click(screen.getByTestId('assistant-markdown-link'))
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('/Users/dev/repo/docs/zh/managing-tasks.md')
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
            subtaskId: 42,
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

    await userEvent.click(screen.getByTestId('assistant-markdown-link'))
    expect(onOpenWorkspaceFile).not.toHaveBeenCalled()
    expect(onOpenFileChangesReview).toHaveBeenCalledTimes(1)
    const request = onOpenFileChangesReview.mock.calls[0][0]
    expect(request.subtaskId).toBe(42)
    expect(request.focusFilePath).toBe('docs/zh/user-guide/chat/managing-tasks.md')
    expect(request.defaultFileTreeVisible).toBe(false)
    expect(onLoadFileChangesDiff).not.toHaveBeenCalled()
    await request.loadDiff()
    expect(onLoadFileChangesDiff).toHaveBeenCalledWith(42)
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

  test('renders Codex local image file mentions as user image previews after refresh', () => {
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

    expect(screen.getByTestId('message-local-image-preview')).toHaveAttribute(
      'src',
      'asset://localhost/Users/yunpeng7/.wegent-executor/workspace/attachments/10406026969952/0/image.png'
    )
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('分析下这个图片')
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

  test('hides Codex local image previews when the converted file URL fails to load', () => {
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

    fireEvent.error(screen.getByTestId('message-local-image-preview'))

    expect(screen.queryByTestId('message-local-image-preview')).not.toBeInTheDocument()
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

  test('opens an enlarged image from a user message attachment preview', async () => {
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
    const lightboxImage = screen.getByTestId('attachment-image-lightbox-image')

    expect(lightbox).toBeInTheDocument()
    expect(lightbox.parentElement).toBe(document.body)
    expect(lightbox).toHaveClass('h-dvh', 'w-dvw', 'p-0')
    expect(lightbox).toHaveClass('overflow-hidden')
    expect(lightboxImage).toHaveClass(
      'max-h-[calc(100dvh-6rem)]',
      'max-w-[calc(100dvw-2rem)]',
      'object-contain'
    )
    expect(lightboxImage).not.toHaveClass('h-full', 'w-full')
    expect(screen.getByTestId('attachment-image-lightbox-close')).toHaveClass('z-20')
    expect(lightboxImage).toHaveAttribute('src', 'blob:message-image-preview')
    expect(lightboxImage).toHaveAttribute('alt', 'diagram.png')
    expect(lightboxImage).toHaveStyle({ transform: 'scale(1)' })

    await userEvent.click(screen.getByTestId('attachment-image-zoom-in'))

    expect(lightboxImage).toHaveStyle({ transform: 'scale(1.25)' })

    await userEvent.click(screen.getByTestId('attachment-image-zoom-reset'))

    expect(lightboxImage).toHaveStyle({ transform: 'scale(1)' })
  })

  test('keeps image attachments compact and allows extras to wrap', async () => {
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
      'flex-row',
      'flex-wrap',
      'justify-end'
    )
    expect(screen.getByTestId('message-image-attachments')).not.toHaveClass('overflow-x-auto')
    expect(previews[0]).toHaveClass('max-h-36', 'max-w-[180px]', 'shrink-0', 'rounded-xl')
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

  test('shows user message hover actions with time and copy', async () => {
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

    expect(screen.getByTestId('message-hover-time')).toHaveTextContent('15:08')

    vi.useRealTimers()

    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: { writeText },
    })

    const copyButton = screen.getByTestId('copy-message-button')
    expect(copyButton).toHaveClass('opacity-0', 'group-hover:opacity-100')

    await userEvent.click(copyButton)

    expect(writeText).toHaveBeenCalledWith('对 bind_shell=openclaw 直接跳过')
  })

  test('collapses long user messages without changing copied content', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: { writeText },
    })
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

  test('shows assistant message hover actions with time and copy', async () => {
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

    expect(screen.getByTestId('message-hover-time')).toHaveTextContent('18:38')

    vi.useRealTimers()

    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: { writeText },
    })

    const copyButton = screen.getByTestId('copy-message-button')
    expect(copyButton).toHaveClass('opacity-0', 'group-hover:opacity-100')

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

  test('renders a compact thinking indicator before the first streamed block arrives', () => {
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

  test('shows a single thinking indicator for streaming assistant messages with blocks', () => {
    const runningBlock: ProcessingBlock = {
      id: 'call-1',
      subtaskId: 1,
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

    expect(screen.getAllByText('正在思考')).toHaveLength(1)
  })

  test('renders process text inside the processing timeline before the following tool', () => {
    const processBlock: ProcessingBlock = {
      id: 'text-1',
      subtaskId: 1,
      type: 'text',
      content: 'Let me explore the repository structure.',
      status: 'done',
      createdAt: 1770000000000,
    }
    const runningBlock: ProcessingBlock = {
      id: 'call-1',
      subtaskId: 1,
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

  test('does not duplicate a text block that matches the final assistant content', () => {
    const finalTextBlock: ProcessingBlock = {
      id: 'text-final',
      subtaskId: 1,
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

    expect(screen.queryByTestId('process-text-block')).not.toBeInTheDocument()
    expect(screen.getByText('这是最终回答。')).toBeInTheDocument()
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

  test('hides executor i18n raw failed content before rendering the error card', () => {
    const rawError =
      '${thinking.execution_failed} async execution: Command failed with exit code 1 (exit code: 1) Error output: Check stderr output for details Claude CLI stderr: error: An unknown error occurred (Unexpected)'

    const { container } = render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: rawError,
            status: 'failed',
            error: 'Agent execution failed: FAILED',
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
      />
    )

    expect(container.querySelector('.assistant-markdown')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('assistant-error-card')).toHaveLength(1)
    expect(
      screen.queryByText(rawError, { selector: '.assistant-markdown p' })
    ).not.toBeInTheDocument()
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

  test('keeps regular long content inside the page while tables and code scroll locally', () => {
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
              '```text',
              longToken,
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
    expect(container.querySelector('pre')).toHaveClass('max-w-full', 'overflow-hidden')
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
