import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { splitContentChunks } from './contentChunks'
import ConversationExportDialog from './dialog'

const reference = {
  deviceId: 'local-device',
  taskId: 'task-1',
  title: 'Export example',
}

afterEach(() => {
  delete window.__WEWORK_DSH_EXTENSIONS__
})

describe('ConversationExportDialog', () => {
  it('exports the complete transcript as the selected HTML format', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'readImageChunk') {
        return {
          chunkBase64: 'AQIDBA==',
          bytesRead: 4,
          eof: true,
          size: 4,
        }
      }
      if (method === 'start') return { exportTaskId: 'export-1' }
      if (method === 'status') {
        const appendCall = request.mock.calls.find(call => call[0] === 'append')
        const content = (appendCall?.[1] as { content?: string } | undefined)?.content ?? ''
        return {
          exportTaskId: 'export-1',
          state: 'completed',
          path: '/tmp/export-example.html',
          size: new TextEncoder().encode(content).byteLength,
        }
      }
      return undefined
    })
    const getTranscript = vi.fn().mockResolvedValue({
      reference,
      title: reference.title,
      complete: true,
      exportedAt: '2026-09-09T00:00:00.000Z',
      turns: [
        {
          id: 'turn-1',
          status: 'done',
          role: 'user',
          items: [
            {
              id: 'user-1',
              type: 'user_message',
              content: 'Hello <Wework>',
              status: 'done',
              attachments: [
                {
                  id: 1,
                  filename: 'screenshot.png',
                  fileSize: 4,
                  mimeType: 'image/png',
                  localPath: '/tmp/screenshot.png',
                },
              ],
            },
          ],
        },
      ],
    })
    const save = vi.fn().mockResolvedValue({
      canceled: false,
      filePath: '/tmp/export-example',
    })
    window.__WEWORK_DSH_EXTENSIONS__ = {
      conversations: { getTranscript },
      dialog: { save },
      backend: {
        scope: vi.fn(() => ({ request })),
      },
    } as typeof window.__WEWORK_DSH_EXTENSIONS__

    render(<ConversationExportDialog />)
    act(() => {
      window.dispatchEvent(
        new CustomEvent('wework:conversation-export:open', {
          detail: reference,
        })
      )
    })

    await screen.findByTestId('conversation-export-dialog')
    fireEvent.click(screen.getByTestId('conversation-export-format-html'))
    await waitFor(() =>
      expect(screen.getByTestId('conversation-export-confirm')).not.toBeDisabled()
    )
    fireEvent.click(screen.getByTestId('conversation-export-confirm'))

    await screen.findByText('Export complete')
    expect(screen.getByTestId('conversation-export-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('conversation-export-completed-path')).toHaveTextContent(
      '/tmp/export-example.html'
    )
    expect(getTranscript).toHaveBeenCalledWith(reference)
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: 'Export example.html',
        filters: [{ name: 'HTML', extensions: ['html'] }],
      })
    )
    expect(request.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[0])
    expect(request).toHaveBeenNthCalledWith(1, 'readImageChunk', {
      path: '/tmp/screenshot.png',
      offset: 0,
      workspacePath: null,
      mimeType: 'image/png',
    })
    expect(request).toHaveBeenNthCalledWith(2, 'start', {
      path: '/tmp/export-example.html',
      archive: false,
      documentName: 'Export example.html',
      assetCount: 0,
    })
    expect(request).toHaveBeenNthCalledWith(
      3,
      'append',
      expect.objectContaining({
        exportTaskId: 'export-1',
        content: expect.stringMatching(
          /Hello &lt;Wework&gt;[\s\S]*<img alt="screenshot.png" src="data:image\/png;base64,AQIDBA=="/
        ),
      })
    )
    expect(request).toHaveBeenNthCalledWith(4, 'finish', { exportTaskId: 'export-1' })
    expect(request).toHaveBeenNthCalledWith(5, 'status', { exportTaskId: 'export-1' })
    fireEvent.click(screen.getByTestId('conversation-export-confirm'))
    expect(screen.queryByTestId('conversation-export-dialog')).toBeNull()
  })

  it('keeps the dialog open when the native save dialog is canceled', async () => {
    window.__WEWORK_DSH_EXTENSIONS__ = {
      conversations: {
        getTranscript: vi.fn().mockResolvedValue({
          reference,
          title: reference.title,
          complete: true,
          exportedAt: '2026-09-09T00:00:00.000Z',
          turns: [
            {
              id: 'turn-1',
              status: 'done',
              items: [
                {
                  id: 'user-1',
                  type: 'user_message',
                  content: 'Export this.',
                  status: 'done',
                  attachments: [],
                },
              ],
            },
          ],
        }),
      },
      dialog: { save: vi.fn().mockResolvedValue({ canceled: true }) },
      backend: {
        scope: vi.fn(),
      },
    } as typeof window.__WEWORK_DSH_EXTENSIONS__

    render(<ConversationExportDialog />)
    act(() => {
      window.dispatchEvent(
        new CustomEvent('wework:conversation-export:open', {
          detail: reference,
        })
      )
    })

    await waitFor(() =>
      expect(screen.getByTestId('conversation-export-confirm')).not.toBeDisabled()
    )
    fireEvent.click(screen.getByTestId('conversation-export-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('conversation-export-confirm')).not.toBeDisabled()
    )
    expect(screen.getByTestId('conversation-export-dialog')).toBeInTheDocument()
  })

  it('defaults Markdown to body without images and switches HTML images on', async () => {
    window.__WEWORK_DSH_EXTENSIONS__ = {
      conversations: {
        getTranscript: vi.fn().mockResolvedValue({
          reference,
          title: reference.title,
          complete: true,
          turns: [
            {
              id: 'turn-1',
              status: 'done',
              items: [
                {
                  id: 'user-1',
                  type: 'user_message',
                  content: 'Hello',
                  status: 'done',
                  attachments: [
                    {
                      id: 1,
                      filename: 'image.png',
                      fileSize: 4,
                      mimeType: 'image/png',
                      localPath: '/tmp/image.png',
                    },
                  ],
                },
              ],
            },
          ],
        }),
      },
      dialog: { save: vi.fn() },
      backend: { scope: vi.fn() },
    } as typeof window.__WEWORK_DSH_EXTENSIONS__

    render(<ConversationExportDialog />)
    act(() => {
      window.dispatchEvent(
        new CustomEvent('wework:conversation-export:open', {
          detail: reference,
        })
      )
    })

    expect(await screen.findByTestId('conversation-export-content-body')).toBeChecked()
    expect(screen.getByTestId('conversation-export-content-images')).not.toBeChecked()
    fireEvent.click(screen.getByTestId('conversation-export-format-html'))
    expect(screen.getByTestId('conversation-export-content-images')).toBeChecked()
    fireEvent.click(screen.getByTestId('conversation-export-format-markdown'))
    expect(screen.getByTestId('conversation-export-content-images')).not.toBeChecked()
  })

  it('exports selected Markdown images as a zip archive', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'start') return { exportTaskId: 'export-zip' }
      if (method === 'status') {
        return {
          exportTaskId: 'export-zip',
          state: 'completed',
          path: '/tmp/export-example.zip',
          size: 128,
        }
      }
      return undefined
    })
    const save = vi.fn().mockResolvedValue({
      canceled: false,
      filePath: '/tmp/export-example',
    })
    window.__WEWORK_DSH_EXTENSIONS__ = {
      conversations: {
        getTranscript: vi.fn().mockResolvedValue({
          reference,
          title: reference.title,
          complete: true,
          turns: [
            {
              id: 'turn-1',
              status: 'done',
              items: [
                {
                  id: 'user-1',
                  type: 'user_message',
                  content: 'Screenshot',
                  status: 'done',
                  attachments: [
                    {
                      id: 1,
                      filename: 'image.png',
                      fileSize: 4,
                      mimeType: 'image/png',
                      localPath: '/tmp/image.png',
                    },
                  ],
                },
              ],
            },
          ],
        }),
      },
      dialog: { save },
      backend: {
        scope: vi.fn(() => ({ request })),
      },
    } as typeof window.__WEWORK_DSH_EXTENSIONS__

    render(<ConversationExportDialog />)
    act(() => {
      window.dispatchEvent(
        new CustomEvent('wework:conversation-export:open', {
          detail: reference,
        })
      )
    })
    await waitFor(() =>
      expect(screen.getByTestId('conversation-export-confirm')).not.toBeDisabled()
    )
    fireEvent.click(screen.getByTestId('conversation-export-content-images'))
    fireEvent.click(screen.getByTestId('conversation-export-confirm'))

    await screen.findByText('Export complete')
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: 'Export example.zip',
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      })
    )
    expect(request).toHaveBeenCalledWith('start', {
      path: '/tmp/export-example.zip',
      archive: true,
      documentName: 'Export example.md',
      assetCount: 1,
    })
    expect(request).toHaveBeenCalledWith('addAsset', {
      exportTaskId: 'export-zip',
      archivePath: 'images/image.png',
      path: '/tmp/image.png',
      workspacePath: null,
    })
  })

  it('traps focus, closes with Escape, and restores the previous focus', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    window.__WEWORK_DSH_EXTENSIONS__ = {
      conversations: {
        getTranscript: vi.fn().mockResolvedValue({
          reference,
          title: reference.title,
          complete: true,
          turns: [],
        }),
      },
      dialog: { save: vi.fn() },
      backend: { scope: vi.fn() },
    } as typeof window.__WEWORK_DSH_EXTENSIONS__

    render(<ConversationExportDialog />)
    act(() => {
      window.dispatchEvent(
        new CustomEvent('wework:conversation-export:open', {
          detail: reference,
        })
      )
    })

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog).toHaveFocus())
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(screen.getByTestId('conversation-export-cancel')).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(trigger).toHaveFocus()
    trigger.remove()
  })
})

describe('splitContentChunks', () => {
  it('does not split a Unicode surrogate pair', () => {
    const content = `${'a'.repeat(128 * 1024 - 1)}😀tail`
    const chunks = splitContentChunks(content)

    expect(chunks).toHaveLength(2)
    expect(chunks.join('')).toBe(content)
    expect(chunks[0]).toBe('a'.repeat(128 * 1024 - 1))
    expect(chunks[1]).toBe('😀tail')
  })
})
