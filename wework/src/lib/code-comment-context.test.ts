import { describe, expect, test } from 'vitest'
import type { CodeCommentContext } from '@/types/workspace-files'
import { appendCodeCommentContexts } from './code-comment-context'

describe('appendCodeCommentContexts', () => {
  const comment: CodeCommentContext = {
    id: 'comment-1',
    filePath: '/workspace/project/src/main.ts',
    fileName: 'main.ts',
    startLine: 3,
    endLine: 5,
    selectedText: 'const value = 1',
    comment: 'Please explain this value',
    createdAt: '2026-06-12T00:00:00.000Z',
  }

  test('appends path, line range, selected code, and comment', () => {
    expect(appendCodeCommentContexts('Please review', [comment])).toContain(
      'File: /workspace/project/src/main.ts',
    )
    expect(appendCodeCommentContexts('Please review', [comment])).toContain('Lines: 3-5')
    expect(appendCodeCommentContexts('Please review', [comment])).toContain('const value = 1')
    expect(appendCodeCommentContexts('Please review', [comment])).toContain(
      'Please explain this value',
    )
  })
})
