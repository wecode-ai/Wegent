import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
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
