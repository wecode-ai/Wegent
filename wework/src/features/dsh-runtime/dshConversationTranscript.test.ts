import { describe, expect, test, vi } from 'vitest'

import {
  isConversationAssetRequestAuthorized,
  loadDshConversationTranscript,
  readConversationAssetChunk,
  resolveConversationAssetPath,
} from './dshConversationTranscript'

describe('loadDshConversationTranscript', () => {
  test('loads full content and projects only the user-visible conversation model', async () => {
    const loadTranscript = vi.fn().mockResolvedValue({
      fullContent: true,
      messages: [],
      turns: [
        {
          id: 'turn-1',
          status: 'done',
          items: [
            {
              id: 'user-1',
              type: 'user_message',
              message: {
                id: 'user-1',
                role: 'user',
                status: 'done',
                createdAt: '2026-09-09T08:00:00.000Z',
                content:
                  '<application_context>hidden</application_context>\n\nExport this conversation',
                attachments: [
                  {
                    id: 1,
                    filename: 'brief.pdf',
                    file_size: 42,
                    mime_type: 'application/pdf',
                    file_extension: 'pdf',
                    status: 'ready',
                    created_at: '2026-09-09T08:00:00.000Z',
                  },
                ],
              },
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: 'Done.',
              createdAt: '2026-09-09T08:00:01.000Z',
            },
            {
              id: 'tool-1',
              type: 'block',
              block: {
                id: 'tool-1',
                subtaskId: 'turn-1',
                type: 'tool',
                toolName: 'read_file',
                toolInput: { path: 'README.md' },
                toolOutput: 'contents',
                status: 'done',
                createdAt: 1,
              },
            },
            {
              id: 'subagent-1',
              type: 'block',
              block: {
                id: 'subagent-1',
                subtaskId: 'turn-1',
                type: 'subagent',
                title: 'Inspect tests',
                output: 'The focused tests pass.',
                status: 'done',
                createdAt: 2,
              },
            },
          ],
        },
      ],
    })

    const result = await loadDshConversationTranscript(
      { deviceId: 'device-1', taskId: 'task-1' },
      null,
      loadTranscript
    )

    expect(loadTranscript).toHaveBeenCalledWith(
      { deviceId: 'device-1', taskId: 'task-1', workspacePath: undefined },
      { includeFullContent: true }
    )
    expect(result.title).toBe('Export this conversation')
    expect(result.complete).toBe(true)
    expect(result.turns[0].items).toEqual([
      {
        id: 'user-1',
        type: 'user_message',
        content: 'Export this conversation',
        createdAt: '2026-09-09T08:00:00.000Z',
        status: 'done',
        attachments: [
          {
            id: 1,
            filename: 'brief.pdf',
            fileSize: 42,
            mimeType: 'application/pdf',
            localPath: undefined,
            previewUrl: undefined,
          },
        ],
      },
      {
        id: 'assistant-1',
        type: 'assistant_text',
        content: 'Done.',
        createdAt: '2026-09-09T08:00:01.000Z',
      },
      {
        id: 'tool-1',
        type: 'block',
        block: {
          type: 'tool',
          toolName: 'read_file',
          toolInput: { path: 'README.md' },
          toolOutput: 'contents',
          status: 'done',
        },
      },
      {
        id: 'subagent-1',
        type: 'block',
        block: {
          type: 'text',
          content: 'The focused tests pass.',
          status: 'done',
        },
      },
    ])
  })

  test('exports the available snapshot without refreshing an active writer', async () => {
    const result = await loadDshConversationTranscript(
      { deviceId: 'device-1', taskId: 'task-1' },
      null,
      vi.fn().mockResolvedValue({ fullContent: false, messages: [], turns: [] })
    )

    expect(result.complete).toBe(false)
    expect(result.title).toBe('Conversation')
  })

  test('authorizes every local asset referenced by the exported conversation', async () => {
    const snapshot = {
      reference: {
        deviceId: 'device-1',
        taskId: 'task-1',
        workspacePath: '/workspace/task-1',
      },
      title: 'Conversation',
      complete: true,
      turns: [
        {
          id: 'turn-1',
          status: 'done',
          items: [
            {
              id: 'user-1',
              type: 'user_message' as const,
              content: '![Relative](../shared/evidence.png)',
              status: 'done',
              attachments: [
                {
                  id: 1,
                  filename: 'brief.pdf',
                  fileSize: 42,
                  mimeType: 'application/pdf',
                  localPath: '/Users/me/Documents/brief.pdf',
                },
              ],
            },
          ],
        },
      ],
    }

    expect(
      isConversationAssetRequestAuthorized(snapshot, {
        path: '/Users/me/Documents/brief.pdf',
        workspacePath: '/workspace/task-1',
        offset: 0,
        length: 128,
      })
    ).toBe(true)
    expect(
      isConversationAssetRequestAuthorized(snapshot, {
        path: '../shared/evidence.png',
        workspacePath: '/workspace/task-1',
        offset: 0,
        length: 128,
      })
    ).toBe(true)
    expect(
      isConversationAssetRequestAuthorized(snapshot, {
        path: '/Users/me/.ssh/id_rsa',
        workspacePath: '/workspace/task-1',
        offset: 0,
        length: 128,
      })
    ).toBe(false)
    expect(
      resolveConversationAssetPath({
        path: '../shared/evidence.png',
        workspacePath: '/workspace/task-1',
      })
    ).toBe('/workspace/shared/evidence.png')
  })

  test('reads an authorized conversation asset through the host reader', async () => {
    const snapshot = {
      reference: {
        deviceId: 'device-1',
        taskId: 'task-1',
        workspacePath: '/workspace',
      },
      title: 'Conversation',
      complete: true,
      turns: [
        {
          id: 'turn-1',
          status: 'done',
          items: [
            {
              id: 'user-1',
              type: 'user_message' as const,
              content: 'See the attachment.',
              status: 'done',
              attachments: [
                {
                  id: 1,
                  filename: 'outside.txt',
                  fileSize: 7,
                  mimeType: 'text/plain',
                  localPath: '/outside/conversation/outside.txt',
                },
              ],
            },
          ],
        },
      ],
    }
    const readFileChunk = vi.fn().mockResolvedValue({
      chunkBase64: 'Y29udGVudA==',
      bytesRead: 7,
      eof: true,
      size: 7,
    })

    await expect(
      readConversationAssetChunk(
        snapshot,
        {
          path: '/outside/conversation/outside.txt',
          workspacePath: '/workspace',
          offset: 0,
          length: 1024,
        },
        readFileChunk
      )
    ).resolves.toEqual({
      chunkBase64: 'Y29udGVudA==',
      bytesRead: 7,
      eof: true,
      size: 7,
    })
    expect(readFileChunk).toHaveBeenCalledWith({
      path: '/outside/conversation/outside.txt',
      offset: 0,
      length: 1024,
    })
  })
})
