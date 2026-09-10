import { describe, expect, test } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { buildConversationOutputs } from './conversationOutputs'

describe('buildConversationOutputs', () => {
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
})
