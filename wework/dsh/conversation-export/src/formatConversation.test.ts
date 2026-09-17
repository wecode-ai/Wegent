import { describe, expect, test } from 'vitest'

import { conversationExportFilename, formatConversation } from './formatConversation'

const snapshot = {
  reference: { deviceId: 'device-1', taskId: 'task-1' },
  title: 'Export <demo>',
  complete: true,
  turns: [
    {
      id: 'turn-1',
      status: 'done',
      items: [
        {
          id: 'user-1',
          type: 'user_message' as const,
          content: 'Please export this.',
          status: 'done',
          attachments: [
            {
              id: 1,
              filename: 'brief.pdf',
              fileSize: 42,
              mimeType: 'application/pdf',
            },
            {
              id: 2,
              filename: 'diagram.png',
              fileSize: 3,
              mimeType: 'image/png',
              dataUrl: 'data:image/png;base64,AQID',
            },
          ],
        },
        {
          id: 'assistant-1',
          type: 'assistant_text' as const,
          content: 'Ready.',
        },
        {
          id: 'tool-1',
          type: 'block' as const,
          block: {
            type: 'tool' as const,
            toolName: 'read_file',
            toolInput: { path: '<README.md>' },
            toolOutput: 'contents',
            status: 'done',
          },
        },
      ],
    },
  ],
}

describe('formatConversation', () => {
  test('formats Markdown with messages, attachments, and tool details', () => {
    const output = formatConversation(snapshot, 'markdown', new Date('2026-09-09T08:00:00Z'))

    expect(output).toContain('# Export <demo>')
    expect(output).toContain('## User')
    expect(output).toContain('brief.pdf (application/pdf)')
    expect(output).toContain('### Tool: read_file')
    expect(output).toContain('"path": "<README.md>"')
  })

  test('formats a self-contained HTML document and escapes conversation data', () => {
    const output = formatConversation(snapshot, 'html', new Date('2026-09-09T08:00:00Z'))

    expect(output).toContain('<!doctype html>')
    expect(output).toContain('<style>')
    expect(output).toContain('Export &lt;demo&gt;')
    expect(output).toContain('&lt;README.md&gt;')
    expect(output).toContain('<img alt="diagram.png" src="data:image/png;base64,AQID">')
    expect(output).toContain('<details class="process-group">')
    expect(output).toContain('<span>Called 1 tool</span>')
    expect(output).toContain('<details class="process-item tool-call"><summary>read_file</summary>')
    expect(output).not.toContain('<details class="process-group" open')
    expect(output).not.toContain('<README.md>')
  })

  test('groups completed work and selected thinking into one compact collapsed section', () => {
    const output = formatConversation(
      {
        ...snapshot,
        turns: [
          {
            ...snapshot.turns[0],
            items: [
              {
                id: 'thinking-1',
                type: 'block',
                block: {
                  type: 'thinking',
                  content: 'Inspecting the implementation',
                  status: 'done',
                },
              },
              {
                id: 'tool-1',
                type: 'block',
                block: {
                  type: 'tool',
                  toolName: 'bash',
                  toolInput: { command: 'pwd' },
                  status: 'done',
                },
              },
              {
                id: 'tool-2',
                type: 'block',
                block: {
                  type: 'tool',
                  toolName: 'read_file',
                  toolInput: { path: 'README.md' },
                  status: 'done',
                },
              },
              {
                id: 'changes-1',
                type: 'block',
                block: {
                  type: 'file_changes',
                  fileChanges: {
                    files: [{ path: 'README.md' }, { path: 'package.json' }],
                  },
                  status: 'done',
                },
              },
            ],
          },
        ],
      },
      'html',
      new Date('2026-09-09T08:00:00Z')
    )

    expect(output.match(/<details class="process-group">/g)).toHaveLength(1)
    expect(output).toContain('<span>Called 2 tools, edited 2 files, 1 thought process</span>')
    expect(output.match(/<details class="process-item/g)).toHaveLength(4)
    expect(output).toContain('Inspecting the implementation')
    expect(output).toContain('<summary>Thought process</summary>')
  })

  test('links packaged Markdown images and attachments by relative archive path', () => {
    const output = formatConversation(
      {
        ...snapshot,
        turns: [
          {
            ...snapshot.turns[0],
            items: [
              {
                id: 'user-assets',
                type: 'user_message',
                content: '![Evidence](<images/evidence.png>)',
                status: 'done',
                attachments: [
                  {
                    id: 1,
                    filename: 'screenshot.png',
                    fileSize: 4,
                    mimeType: 'image/png',
                    exportPath: 'images/screenshot.png',
                  },
                  {
                    id: 2,
                    filename: 'brief.pdf',
                    fileSize: 8,
                    mimeType: 'application/pdf',
                    exportPath: 'attachments/brief.pdf',
                  },
                ],
              },
            ],
          },
        ],
      },
      'markdown',
      new Date('2026-09-09T08:00:00Z')
    )

    expect(output).toContain('![Evidence](<images/evidence.png>)')
    expect(output).toContain('![screenshot.png](<images/screenshot.png>)')
    expect(output).toContain('- [brief.pdf](<attachments/brief.pdf>)')
  })

  test('renders embedded Markdown images as HTML images', () => {
    const output = formatConversation(
      {
        ...snapshot,
        turns: [
          {
            ...snapshot.turns[0],
            items: [
              {
                id: 'assistant-image',
                type: 'assistant_text',
                content: 'Evidence:\n\n![Screenshot](data:image/png;base64,AQID)',
              },
            ],
          },
        ],
      },
      'html',
      new Date('2026-09-09T08:00:00Z')
    )

    expect(output).toContain('<p>Evidence:</p>')
    expect(output).toContain('<img src="data:image/png;base64,AQID" alt="Screenshot"/>')
    expect(output).not.toContain('![Screenshot]')
  })

  test('marks exports captured while the conversation is active', () => {
    const output = formatConversation(
      { ...snapshot, complete: false },
      'html',
      new Date('2026-09-09T08:00:00Z')
    )

    expect(output).toContain('while the conversation was active')
  })

  test('creates safe filenames with the selected extension', () => {
    expect(conversationExportFilename('  Plan: Q3 / Q4?  ', 'markdown')).toBe('Plan- Q3 - Q4-.md')
    expect(conversationExportFilename('', 'html')).toBe('conversation.html')
  })
})
