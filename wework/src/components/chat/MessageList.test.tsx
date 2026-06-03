import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { MessageList } from './MessageList'

describe('MessageList', () => {
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
    expect(container.firstElementChild).toHaveClass(
      'min-w-0',
      'overflow-x-hidden',
    )
  })

  test('shows user message hover actions with time and copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: { writeText },
    })

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
      />,
    )

    expect(screen.getByTestId('message-hover-time')).toHaveTextContent('15:08')
    const copyButton = screen.getByTestId('copy-message-button')
    expect(copyButton).toHaveClass('opacity-0', 'group-hover:opacity-100')

    await userEvent.click(copyButton)

    expect(writeText).toHaveBeenCalledWith('对 bind_shell=openclaw 直接跳过')
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
      />,
    )

    expect(screen.getByTestId('message-user')).toHaveClass(
      'overflow-x-hidden',
    )
    expect(screen.getByTestId('message-assistant')).toHaveClass(
      'overflow-x-hidden',
    )
    expect(container.querySelector('.assistant-markdown')).toHaveClass(
      'break-words',
      'overflow-x-hidden',
    )
    expect(container.querySelector('table')?.parentElement).toHaveClass(
      'overflow-x-auto',
      'max-w-full',
    )
    expect(container.querySelector('pre')).toHaveClass(
      'max-w-full',
      'overflow-hidden',
    )
  })
})
