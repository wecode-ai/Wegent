import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Attachment } from '@/types/api'
import { AttachmentImagePreview } from './AttachmentImagePreview'

const runtimeMock = vi.hoisted(() => ({
  electron: false,
}))
const desktopHostMock = vi.hoisted(() => ({
  invokeDesktopHost: vi.fn(),
}))
vi.mock('@/api/dsh/desktopHost', () => desktopHostMock)
vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => runtimeMock.electron,
}))

interface PendingFetch {
  resolve: (response: Response) => void
}

function remoteAttachment(id: number): Attachment {
  return {
    id,
    filename: `image-${id}.png`,
    file_size: 1,
    mime_type: 'image/png',
    status: 'ready',
    file_extension: '.png',
    created_at: '2026-08-07T00:00:00.000Z',
  }
}

function localPathAttachment(id: number, localPath: string): Attachment {
  return {
    id,
    filename: `image-${id}.png`,
    file_size: 1,
    mime_type: 'image/png',
    status: 'ready',
    file_extension: '.png',
    created_at: '2026-08-07T00:00:00.000Z',
    local_path: localPath,
  }
}

function previewElement(attachment: Attachment) {
  return (
    <AttachmentImagePreview
      attachment={attachment}
      buttonTestId="preview-button"
      imageTestId="preview-image"
      loadingTestId="preview-loading"
      errorTestId="preview-error"
      imageClassName="h-20 w-20"
      placeholderClassName="h-20 w-20"
    />
  )
}

describe('AttachmentImagePreview', () => {
  const originalCreateObjectUrl = URL.createObjectURL
  let pendingFetches: PendingFetch[]
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    runtimeMock.electron = false
    desktopHostMock.invokeDesktopHost.mockReset()
    pendingFetches = []
    fetchMock = vi.fn(() => {
      let resolveFetch: (response: Response) => void = () => {}
      const promise = new Promise<Response>(resolve => {
        resolveFetch = resolve
      })
      pendingFetches.push({ resolve: resolveFetch })
      return promise
    })
    vi.stubGlobal('fetch', fetchMock)
    URL.createObjectURL = vi.fn(
      () => 'blob:attachment-preview'
    ) as unknown as typeof URL.createObjectURL
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectUrl
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function settleNextFetch() {
    const pending = pendingFetches.shift()
    if (!pending) throw new Error('No pending fetch to settle')
    await act(async () => {
      pending.resolve(
        new Response('preview', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    })
  }

  test('keeps the loaded preview when session events recreate the attachment object with the same content', async () => {
    const { rerender } = render(previewElement(remoteAttachment(1)))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    await settleNextFetch()
    await waitFor(() => {
      const image = screen.getByTestId('preview-image')
      expect(image).toHaveAttribute('data-context-image-filename', 'image-1.png')
      expect(image).not.toHaveAttribute('data-context-image-local-path')
    })

    // Runtime turn/block projections produce a fresh attachment object with
    // the same id and preview source on every session event.
    rerender(previewElement(remoteAttachment(1)))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('preview-image')).toBeInTheDocument()
    expect(screen.queryByTestId('preview-loading')).not.toBeInTheDocument()
  })

  test('resets to the loading state when the attachment content identity actually changes', async () => {
    const { rerender } = render(previewElement(remoteAttachment(1)))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    await settleNextFetch()
    await waitFor(() => {
      expect(screen.getByTestId('preview-image')).toBeInTheDocument()
    })

    rerender(previewElement(remoteAttachment(2)))

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(screen.getByTestId('preview-loading')).toBeInTheDocument()
  })

  test('lightbox loads the selected attachment when equal ids differ by local_path', async () => {
    runtimeMock.electron = true
    desktopHostMock.invokeDesktopHost.mockResolvedValue({
      chunkBase64: Buffer.from('preview').toString('base64'),
      bytesRead: 7,
      eof: true,
      size: 7,
    })
    const first = localPathAttachment(1, '/a.png')
    const second = localPathAttachment(1, '/b.png')
    render(
      <AttachmentImagePreview
        attachment={first}
        galleryAttachments={[first, second]}
        galleryIndex={0}
        buttonTestId="preview-button"
        imageTestId="preview-image"
        loadingTestId="preview-loading"
        errorTestId="preview-error"
        imageClassName="h-20 w-20"
        placeholderClassName="h-20 w-20"
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('preview-image')).toHaveAttribute(
        'data-context-image-local-path',
        '/a.png'
      )
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('preview-button'))
    })
    await waitFor(() => {
      const image = screen.getByTestId('attachment-image-lightbox-image')
      expect(image).toHaveAttribute('src', 'blob:attachment-preview')
      expect(image).toHaveAttribute('data-context-image-filename', 'image-1.png')
      expect(image).toHaveAttribute('data-context-image-local-path', '/a.png')
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('attachment-image-next'))
    })
    await waitFor(() => {
      const image = screen.getByTestId('attachment-image-lightbox-image')
      expect(image).toHaveAttribute('src', 'blob:attachment-preview')
      expect(image).toHaveAttribute('data-context-image-local-path', '/b.png')
    })
  })

  test('loads an Electron local image through declared bounded file chunks', async () => {
    runtimeMock.electron = true
    const observe = vi.fn()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = observe
        disconnect = vi.fn()
      }
    )
    const payload = Buffer.from('electron-preview')
    desktopHostMock.invokeDesktopHost
      .mockResolvedValueOnce({
        chunkBase64: payload.subarray(0, 8).toString('base64'),
        bytesRead: 8,
        eof: false,
        size: payload.length,
      })
      .mockResolvedValueOnce({
        chunkBase64: payload.subarray(8).toString('base64'),
        bytesRead: payload.length - 8,
        eof: true,
        size: payload.length,
      })

    render(previewElement(localPathAttachment(7, '/tmp/electron-image.png')))

    await waitFor(() => {
      expect(screen.getByTestId('preview-image')).toHaveAttribute('src', 'blob:attachment-preview')
    })
    expect(observe).not.toHaveBeenCalled()
    expect(desktopHostMock.invokeDesktopHost).toHaveBeenNthCalledWith(
      1,
      'filesystem.readFileChunk',
      {
        path: '/tmp/electron-image.png',
        offset: 0,
        length: 512 * 1024,
      }
    )
    expect(desktopHostMock.invokeDesktopHost).toHaveBeenNthCalledWith(
      2,
      'filesystem.readFileChunk',
      {
        path: '/tmp/electron-image.png',
        offset: 8,
        length: 512 * 1024,
      }
    )
  })
})
