import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  countConversationExportContent,
  defaultConversationExportSelection,
  prepareConversationExport,
} from './prepareConversationExport'

const snapshot = {
  reference: {
    deviceId: 'device-1',
    taskId: 'task-1',
    workspacePath: '/workspace',
  },
  title: 'Export example',
  complete: true,
  turns: [
    {
      id: 'turn-1',
      status: 'done',
      items: [
        {
          id: 'user-1',
          type: 'user_message' as const,
          content: 'See the files.',
          status: 'done',
          attachments: [
            {
              id: 1,
              filename: 'image.png',
              fileSize: 4,
              mimeType: 'image/png',
              localPath: '/tmp/image.png',
            },
            {
              id: 2,
              filename: 'brief.pdf',
              fileSize: 8,
              mimeType: 'application/pdf',
              localPath: '/tmp/brief.pdf',
            },
          ],
        },
        {
          id: 'assistant-1',
          type: 'assistant_text' as const,
          content: 'Evidence:\n\n![Screenshot](evidence/screenshot.png)',
        },
        {
          id: 'thinking-1',
          type: 'block' as const,
          block: {
            type: 'thinking' as const,
            content: 'Inspecting files',
            status: 'done',
          },
        },
        {
          id: 'tool-1',
          type: 'block' as const,
          block: {
            type: 'tool' as const,
            toolName: 'read_file',
            toolInput: { path: 'README.md' },
            status: 'done',
          },
        },
      ],
    },
  ],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('prepareConversationExport', () => {
  test('uses format-specific defaults and counts selectable content', () => {
    expect(defaultConversationExportSelection('markdown')).toEqual({
      body: true,
      tools: false,
      thinking: false,
      images: false,
      attachments: false,
    })
    expect(defaultConversationExportSelection('html').images).toBe(true)
    expect(countConversationExportContent(snapshot)).toEqual({
      body: 2,
      tools: 1,
      thinking: 1,
      images: 2,
      attachments: 1,
    })
  })

  test('filters unselected processing and image content from Markdown', async () => {
    const result = await prepareConversationExport(
      snapshot,
      'markdown',
      defaultConversationExportSelection('markdown'),
      { request: vi.fn() }
    )

    expect(result.assets).toEqual([])
    expect(result.snapshot.turns[0].items).toHaveLength(2)
    expect(result.snapshot.turns[0].items[1]).toMatchObject({
      type: 'assistant_text',
      content: 'Evidence:\n\nScreenshot',
    })
  })

  test('packages Markdown images and other attachments as uniquely named assets', async () => {
    const result = await prepareConversationExport(
      snapshot,
      'markdown',
      {
        body: true,
        tools: true,
        thinking: true,
        images: true,
        attachments: true,
      },
      { request: vi.fn() }
    )

    expect(result.assets).toEqual([
      {
        archivePath: 'images/image.png',
        kind: 'local',
        path: '/tmp/image.png',
        workspacePath: '/workspace',
      },
      {
        archivePath: 'attachments/brief.pdf',
        kind: 'local',
        path: '/tmp/brief.pdf',
        workspacePath: '/workspace',
      },
      {
        archivePath: 'images/screenshot.png',
        kind: 'local',
        path: 'evidence/screenshot.png',
        workspacePath: '/workspace',
      },
    ])
    expect(result.snapshot.turns[0].items[1]).toMatchObject({
      content: 'Evidence:\n\n![Screenshot](<images/screenshot.png>)',
    })
  })

  test('embeds HTML images without creating archive assets', async () => {
    const request = vi.fn().mockResolvedValue({
      chunkBase64: 'AQIDBA==',
      bytesRead: 4,
      eof: true,
      size: 4,
    })

    const result = await prepareConversationExport(
      snapshot,
      'html',
      defaultConversationExportSelection('html'),
      { request }
    )

    expect(result.assets).toEqual([])
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledWith('readImageChunk', {
      path: '/tmp/image.png',
      offset: 0,
      workspacePath: null,
      mimeType: 'image/png',
    })
    expect(request).toHaveBeenCalledWith('readImageChunk', {
      path: 'evidence/screenshot.png',
      offset: 0,
      workspacePath: '/workspace',
      mimeType: 'image/png',
    })
    expect(result.snapshot.turns[0].items[0]).toMatchObject({
      attachments: [{ dataUrl: 'data:image/png;base64,AQIDBA==' }],
    })
    expect(result.snapshot.turns[0].items[1]).toMatchObject({
      content: 'Evidence:\n\n![Screenshot](data:image/png;base64,AQIDBA==)',
    })
  })

  test('rejects non-final base64 chunks that are not aligned to three bytes', async () => {
    const request = vi.fn().mockResolvedValue({
      chunkBase64: 'AQ==',
      bytesRead: 1,
      eof: false,
      size: 4,
    })

    await expect(
      prepareConversationExport(snapshot, 'html', defaultConversationExportSelection('html'), {
        request,
      })
    ).rejects.toThrow('misaligned image chunk')
  })

  test('rejects remote images whose declared size exceeds the limit', async () => {
    const remoteSnapshot = {
      ...snapshot,
      turns: [
        {
          id: 'turn-remote',
          status: 'done',
          items: [
            {
              id: 'assistant-remote',
              type: 'assistant_text' as const,
              content: '![Remote](https://example.com/image.png)',
            },
          ],
        },
      ],
    }
    const fetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1]), {
        headers: { 'content-length': String(50 * 1024 * 1024 + 1) },
      })
    )
    vi.stubGlobal('fetch', fetch)

    await expect(
      prepareConversationExport(
        remoteSnapshot,
        'html',
        defaultConversationExportSelection('html'),
        { request: vi.fn() }
      )
    ).rejects.toThrow('image exceeds 50 MB')
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/image.png',
      expect.objectContaining({
        credentials: 'same-origin',
        signal: expect.any(AbortSignal),
      })
    )
  })
})
