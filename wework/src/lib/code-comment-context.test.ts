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
  const singleLineComment: CodeCommentContext = {
    ...comment,
    id: 'comment-2',
    startLine: 8,
    endLine: 8,
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

  test('omits the message separator when message is empty', () => {
    expect(appendCodeCommentContexts('', [comment])).toBe(
      [
        '<code_comment_context>',
        'Comment 1',
        'File: /workspace/project/src/main.ts',
        'Lines: 3-5',
        'Selected code:',
        '```',
        'const value = 1',
        '```',
        'User comment: Please explain this value',
        '</code_comment_context>',
      ].join('\n'),
    )
  })

  test('omits the message separator when message is whitespace', () => {
    expect(appendCodeCommentContexts('  \n\t  ', [comment])).toBe(
      [
        '<code_comment_context>',
        'Comment 1',
        'File: /workspace/project/src/main.ts',
        'Lines: 3-5',
        'Selected code:',
        '```',
        'const value = 1',
        '```',
        'User comment: Please explain this value',
        '</code_comment_context>',
      ].join('\n'),
    )
  })

  test('returns the original message when no contexts exist', () => {
    expect(appendCodeCommentContexts('  Please review  ', [])).toBe('  Please review  ')
  })

  test('formats a single-line selection range', () => {
    expect(appendCodeCommentContexts('Please review', [singleLineComment])).toContain('Lines: 8')
    expect(appendCodeCommentContexts('Please review', [singleLineComment])).not.toContain(
      'Lines: 8-8',
    )
  })

  test('wraps multiple comments in one code comment context tag block', () => {
    expect(appendCodeCommentContexts('Please review', [comment, singleLineComment])).toBe(
      [
        'Please review',
        '',
        '<code_comment_context>',
        'Comment 1',
        'File: /workspace/project/src/main.ts',
        'Lines: 3-5',
        'Selected code:',
        '```',
        'const value = 1',
        '```',
        'User comment: Please explain this value',
        '',
        'Comment 2',
        'File: /workspace/project/src/main.ts',
        'Lines: 8',
        'Selected code:',
        '```',
        'const value = 1',
        '```',
        'User comment: Please explain this value',
        '</code_comment_context>',
      ].join('\n'),
    )
  })
})
