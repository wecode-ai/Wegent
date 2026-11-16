import type { CodeCommentContext } from '@/types/workspace-files'
import { describe, expect, test } from 'vitest'
import { appendCodeCommentContexts, parseCodeCommentContexts } from './code-comment-context'

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
        selectedText: expect.stringContaining('"type": "browser_annotation"'),
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

  test('parses comments back out and strips the context block', () => {
    const content = appendCodeCommentContexts('请根据批注处理', [comment, browserComment])
    const parsed = parseCodeCommentContexts(content)

    expect(parsed?.content).toBe('请根据批注处理')
    expect(parsed?.codeComments).toHaveLength(2)
    expect(parsed?.codeComments[0]).toMatchObject({
      comment: 'Please explain this value',
      source: 'code_selection',
      startLine: 3,
      endLine: 5,
    })
    expect(parsed?.codeComments[1]).toMatchObject({
      comment: '这个侧边栏太抢眼',
      source: 'browser_annotation',
    })
  })

  test('keeps the message untouched when the payload is not a valid annotation payload', () => {
    expect(
      parseCodeCommentContexts(
        'before\n\n<workspace_comment_context>\nnot-json\n</workspace_comment_context>'
      )
    ).toBeNull()
  })

  test('restores the browser annotation target for history previews', () => {
    const withTarget: CodeCommentContext = {
      ...browserComment,
      selectedText: JSON.stringify({
        type: 'browser_annotation',
        url: 'https://example.test/',
        rect: { x: 10, y: 20, width: 100, height: 80 },
        target: {
          tagName: 'button',
          text: '提交审批',
          isSimpleText: true,
          rect: { x: 10, y: 20, width: 100, height: 80 },
        },
      }),
    }
    const parsed = parseCodeCommentContexts(appendCodeCommentContexts('处理', [withTarget]))

    expect(parsed?.codeComments[0].browserAnnotation?.target).toMatchObject({
      tagName: 'button',
      text: '提交审批',
      isSimpleText: true,
    })
  })
})
