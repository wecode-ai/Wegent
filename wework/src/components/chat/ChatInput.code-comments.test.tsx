import type { CodeCommentContext } from '@/types/workspace-files'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (key: string, options?: string | { count?: number }) => {
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

vi.mock('@/desktop/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/desktop/appPreferences')>()
  return {
    ...actual,
    getAppPreferences: vi.fn().mockResolvedValue(actual.defaultAppPreferences),
  }
})

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
      />
    )

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})
