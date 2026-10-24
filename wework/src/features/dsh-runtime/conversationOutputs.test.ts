import { describe, expect, test } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { buildConversationOutputs } from './conversationOutputs'

describe('buildConversationOutputs', () => {
  test('collects file citations as sources or outputs across Office and document formats', () => {
    const messages: WorkbenchMessage[] = [
      {
        id: 'citations',
        role: 'assistant',
        status: 'done',
        createdAt: '2026-10-24T08:00:00Z',
        content: [
          ':codex-file-citation{path="/tmp/original.pptx" purpose=source}',
          ':codex-file-citation{path="/tmp/result.pptx" purpose=output}',
          '::codex-file-citation{path="/tmp/book%20final.xlsx" artifact_kind=workbook sheet=Summary range=A1:D8}',
          ':codex-file-citation{path="/tmp/report.pdf" purpose=output}',
          ':codex-file-citation{path="/tmp/result.pptx" purpose=output}',
          '【F:src/main.ts†L4-L9】',
          '`' + ':codex-file-citation{path="/tmp/example.pdf" purpose=output}' + '`',
        ].join('\n\n'),
      },
    ]
    const result = buildConversationOutputs(messages)
    expect(result.outputs.map(item => item.resource)).toEqual([
      { kind: 'file', path: '/tmp/report.pdf' },
      { kind: 'file', path: '/tmp/book%20final.xlsx' },
      { kind: 'file', path: '/tmp/result.pptx' },
    ])
    expect(result.sources.map(item => item.resource)).toEqual([
      { kind: 'file', path: 'src/main.ts' },
      { kind: 'file', path: '/tmp/original.pptx' },
    ])
  })

  test('builds canonical outputs and sources from the conversation', () => {
    const messages: WorkbenchMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Use this source',
        status: 'done',
        createdAt: '2026-09-10T08:00:00Z',
        attachments: [
          {
            id: 7,
            filename: 'brief.pdf',
            file_size: 120,
            mime_type: 'application/pdf',
            status: 'ready',
            file_extension: 'pdf',
            created_at: '2026-09-10T08:00:00Z',
            local_path: '/tmp/brief.pdf',
          },
        ],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content:
          'Created [report.md](/workspace/report.md) and [demo](</workspace/demo.html>). See [OpenAI](https://openai.com).',
        status: 'done',
        createdAt: '2026-09-10T08:01:00Z',
        blocks: [
          {
            id: 'image-1',
            type: 'tool',
            toolName: 'image_generation',
            toolInput: {},
            status: 'done',
            createdAt: 1,
            renderPayload: {
              revisedPrompt: 'Architecture diagram',
              mimeType: 'image/png',
              source: {
                type: 'workspace_file',
                path: '/workspace/diagram.png',
              },
            },
          },
          {
            id: 'search-1',
            type: 'tool',
            toolName: 'web_search',
            toolInput: {
              type: 'open_page',
              url: 'https://example.com/reference',
            },
            status: 'done',
            createdAt: 2,
          },
        ],
        memoryCitations: [
          {
            entries: [{ path: '/workspace/MEMORY.md', lineStart: 4 }],
          },
        ],
      },
    ]

    const summary = buildConversationOutputs(messages)

    expect(summary.outputs.map(item => item.title)).toEqual([
      'Architecture diagram',
      'demo',
      'report.md',
    ])
    expect(summary.sources.map(item => item.title)).toEqual([
      'MEMORY.md',
      'example.com',
      'OpenAI',
      'brief.pdf',
    ])
  })

  test('keeps the latest occurrence when resources repeat', () => {
    const messages: WorkbenchMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '[Old title](/workspace/report.md)',
        status: 'done',
        createdAt: '2026-09-10T08:00:00Z',
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: '[Final report](/workspace/report.md)',
        status: 'done',
        createdAt: '2026-09-10T08:01:00Z',
      },
    ]

    expect(buildConversationOutputs(messages).outputs).toEqual([
      {
        id: 'file:/workspace/report.md',
        kind: 'file',
        resource: { kind: 'file', path: '/workspace/report.md' },
        title: 'Final report',
      },
    ])
  })

  test('preserves balanced parentheses in external Markdown destinations', () => {
    const messages: WorkbenchMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '[Versioned page](https://example.com/page_(v2))',
        status: 'done',
        createdAt: '2026-09-10T08:00:00Z',
      },
    ]

    expect(buildConversationOutputs(messages).sources).toEqual([
      {
        id: 'website:https://example.com/page_(v2)',
        kind: 'website',
        resource: { kind: 'url', url: 'https://example.com/page_(v2)' },
        title: 'Versioned page',
      },
    ])
  })
})
