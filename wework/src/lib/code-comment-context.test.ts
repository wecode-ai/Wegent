import { describe, expect, test } from 'vitest'
import type { CodeCommentContext } from '@/types/workspace-files'
import { appendCodeCommentContexts } from './code-comment-context'

function parseContextPayload(output: string): unknown {
  const match = output.match(
    /<code_comment_context>\n([\s\S]*)\n<\/code_comment_context>/,
  )
  if (!match) {
    throw new Error('Missing code comment context block')
  }
  return JSON.parse(match[1])
}

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
    const output = appendCodeCommentContexts('Please review', [comment])

    expect(parseContextPayload(output)).toEqual([
      {
        commentNumber: 1,
        filePath: '/workspace/project/src/main.ts',
        fileName: 'main.ts',
        lines: '3-5',
        selectedCode: 'const value = 1',
        userComment: 'Please explain this value',
        createdAt: '2026-06-12T00:00:00.000Z',
      },
    ])
  })

  test('omits the message separator when message is empty', () => {
    expect(appendCodeCommentContexts('', [comment])).toBe(
      [
        '<code_comment_context>',
        JSON.stringify(
          [
            {
              commentNumber: 1,
              filePath: '/workspace/project/src/main.ts',
              fileName: 'main.ts',
              lines: '3-5',
              selectedCode: 'const value = 1',
              userComment: 'Please explain this value',
              createdAt: '2026-06-12T00:00:00.000Z',
            },
          ],
          null,
          2,
        ),
        '</code_comment_context>',
      ].join('\n'),
    )
  })

  test('omits the message separator when message is whitespace', () => {
    expect(appendCodeCommentContexts('  \n\t  ', [comment])).toBe(
      [
        '<code_comment_context>',
        JSON.stringify(
          [
            {
              commentNumber: 1,
              filePath: '/workspace/project/src/main.ts',
              fileName: 'main.ts',
              lines: '3-5',
              selectedCode: 'const value = 1',
              userComment: 'Please explain this value',
              createdAt: '2026-06-12T00:00:00.000Z',
            },
          ],
          null,
          2,
        ),
        '</code_comment_context>',
      ].join('\n'),
    )
  })

  test('returns the original message when no contexts exist', () => {
    expect(appendCodeCommentContexts('  Please review  ', [])).toBe('  Please review  ')
  })

  test('formats a single-line selection range', () => {
    const output = appendCodeCommentContexts('Please review', [singleLineComment])

    expect(parseContextPayload(output)).toMatchObject([{ lines: '8' }])
    expect(output).not.toContain('"lines": "8-8"')
  })

  test('wraps multiple comments in one code comment context tag block', () => {
    const output = appendCodeCommentContexts('Please review', [comment, singleLineComment])

    expect(output.startsWith('Please review\n\n<code_comment_context>')).toBe(true)
    expect(parseContextPayload(output)).toMatchObject([
      { commentNumber: 1, lines: '3-5' },
      { commentNumber: 2, lines: '8' },
    ])
  })

  test('serializes selected code and comments without extra context delimiters', () => {
    const output = appendCodeCommentContexts('Review this', [
      {
        ...comment,
        selectedText: '```ts\nconst tag = "</code_comment_context>"\n```',
        comment: 'Do not close </code_comment_context>',
      },
    ])

    expect(output.match(/<\/code_comment_context>/g)).toHaveLength(1)
    expect(output).toContain('\\u003c/code_comment_context>')
    expect(parseContextPayload(output)).toMatchObject([
      {
        selectedCode: '```ts\nconst tag = "</code_comment_context>"\n```',
        userComment: 'Do not close </code_comment_context>',
      },
    ])
  })
})
