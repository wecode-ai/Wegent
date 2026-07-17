import { describe, expect, test } from 'vitest'
import type { CodeCommentContext } from '@/types/workspace-files'
import { appendCodeCommentContexts } from './code-comment-context'

const CONTEXT_INSTRUCTION =
  'The user attached the following comments. Treat browser_annotation items as comments on parts of the visible web page, and code_selection items as comments on selected code.'

function parseContextPayload(output: string): unknown {
  const match = output.match(
    /<workspace_comment_context>\n[^\n]*\n([\s\S]*)\n<\/workspace_comment_context>/
  )
  if (!match) {
    throw new Error('Missing workspace comment context block')
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
  const browserComment: CodeCommentContext = {
    id: 'browser-comment-1',
    filePath: 'browser:https://example.test/',
    fileName: 'example.test',
    startLine: 1,
    endLine: 1,
    selectedText: JSON.stringify({
      type: 'browser_annotation',
      url: 'https://example.test/',
      rect: { x: 10, y: 20, width: 100, height: 80 },
    }),
    comment: '这个侧边栏太抢眼',
    createdAt: '2026-06-12T00:00:00.000Z',
  }

  test('appends path, line range, selected text, and comment', () => {
    const output = appendCodeCommentContexts('Please review', [comment])

    expect(parseContextPayload(output)).toEqual([
      {
        commentNumber: 1,
        source: 'code_selection',
        location: 'File: /workspace/project/src/main.ts, lines 3-5',
        filePath: '/workspace/project/src/main.ts',
        fileName: 'main.ts',
        lines: '3-5',
        selectedText: 'const value = 1',
        userComment: 'Please explain this value',
        createdAt: '2026-06-12T00:00:00.000Z',
      },
    ])
  })

  test('omits the message separator when message is empty', () => {
    expect(appendCodeCommentContexts('', [comment])).toBe(
      [
        '<workspace_comment_context>',
        CONTEXT_INSTRUCTION,
        JSON.stringify(
          [
            {
              commentNumber: 1,
              source: 'code_selection',
              location: 'File: /workspace/project/src/main.ts, lines 3-5',
              filePath: '/workspace/project/src/main.ts',
              fileName: 'main.ts',
              lines: '3-5',
              selectedText: 'const value = 1',
              userComment: 'Please explain this value',
              createdAt: '2026-06-12T00:00:00.000Z',
            },
          ],
          null,
          2
        ),
        '</workspace_comment_context>',
      ].join('\n')
    )
  })

  test('omits the message separator when message is whitespace', () => {
    expect(appendCodeCommentContexts('  \n\t  ', [comment])).toBe(
      appendCodeCommentContexts('', [comment])
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

  test('wraps multiple comments in one workspace comment context tag block', () => {
    const output = appendCodeCommentContexts('Please review', [comment, singleLineComment])

    expect(output.startsWith('Please review\n\n<workspace_comment_context>')).toBe(true)
    expect(parseContextPayload(output)).toMatchObject([
      { commentNumber: 1, source: 'code_selection', lines: '3-5' },
      { commentNumber: 2, source: 'code_selection', lines: '8' },
    ])
  })

  test('serializes browser annotations as web page comments', () => {
    const output = appendCodeCommentContexts('', [browserComment])

    expect(parseContextPayload(output)).toMatchObject([
      {
        commentNumber: 1,
        source: 'browser_annotation',
        location: 'Web page: https://example.test/',
        filePath: 'browser:https://example.test/',
        fileName: 'example.test',
        lines: null,
        selectedText: expect.stringContaining('"type":"browser_annotation"'),
        userComment: '这个侧边栏太抢眼',
      },
    ])
  })

  test('serializes selected text and comments without extra context delimiters', () => {
    const output = appendCodeCommentContexts('Review this', [
      {
        ...comment,
        selectedText: '```ts\nconst tag = "</workspace_comment_context>"\n```',
        comment: 'Do not close </workspace_comment_context>',
      },
    ])

    expect(output.match(/<\/workspace_comment_context>/g)).toHaveLength(1)
    expect(output).toContain('\\u003c/workspace_comment_context>')
    expect(parseContextPayload(output)).toMatchObject([
      {
        selectedText: '```ts\nconst tag = "</workspace_comment_context>"\n```',
        userComment: 'Do not close </workspace_comment_context>',
      },
    ])
  })
})
