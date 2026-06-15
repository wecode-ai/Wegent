import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Attachment } from '@/types/api'
import type { ProcessingBlock } from '@/types/workbench'
import { MessageList } from './MessageList'
import '@/i18n'

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
    expect(screen.getByText('正在思考')).toBeInTheDocument()
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
