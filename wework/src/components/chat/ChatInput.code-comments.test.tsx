import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { CodeCommentContext } from '@/types/workspace-files'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: string | { count?: number },
    ) => {
      if (typeof options === 'string') return options
      if (key === 'workbench.code_comment_count') {
        return `${options?.count ?? 0} 个评论`
      }
      if (key === 'workbench.remove_code_comments') {
        return '移除代码评论'
      }
      return key
    },
  }),
}))

import { ChatInput } from './ChatInput'

const codeComment: CodeCommentContext = {
  id: 'comment-1',
  filePath: '/workspace/project/src/main.ts',
  fileName: 'main.ts',
  startLine: 1,
  endLine: 1,
  selectedText: 'const value = 1',
  comment: 'Check this',
  createdAt: '2026-06-12T00:00:00.000Z',
}

describe('ChatInput code comments', () => {
  test('renders and clears code comment context chip in desktop composer', async () => {
    const onClearCodeComments = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        codeComments={[codeComment]}
        onClearCodeComments={onClearCodeComments}
      />,
    )

    expect(screen.getByTestId('code-comment-context-badge')).toHaveTextContent('1 个评论')
    await userEvent.click(screen.getByTestId('remove-code-comment-context-button'))
    expect(onClearCodeComments).toHaveBeenCalledTimes(1)
  })

  test('submits comments-only desktop composer', async () => {
    const onSubmit = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        variant="desktop"
        codeComments={[codeComment]}
        onClearCodeComments={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('supports code comment chips in compact composer', async () => {
    const onSubmit = vi.fn()
    const onClearCodeComments = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        codeComments={[codeComment]}
        onClearCodeComments={onClearCodeComments}
      />,
    )

    expect(screen.getByTestId('code-comment-context-badge')).toHaveTextContent('1 个评论')
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('remove-code-comment-context-button'))
    expect(onClearCodeComments).toHaveBeenCalledTimes(1)
  })
})
