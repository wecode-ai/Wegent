import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createLocalAttachmentApi } from './localAttachments'
import { rememberNativeFilePath } from '@/desktop/nativeFilePaths'

const desktopMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopMocks.invoke,
}))

describe('local attachment API', () => {
  beforeEach(() => {
    desktopMocks.invoke.mockReset()
  })

  afterEach(() => {
    delete window.weworkElectronFiles
  })

  test('references an Electron-selected Windows file without creating a draft copy', async () => {
    const path = 'C:\\Users\\alice\\Downloads\\report.xlsx'
    const file = new File(['spreadsheet'], 'report.xlsx')
    window.weworkElectronFiles = { getPathForFile: () => path }
    const readChunk = vi.spyOn(file, 'slice')
    const progress = vi.fn()

    const api = createLocalAttachmentApi()
    const attachment = await api.uploadAttachment(file, progress)
    await api.deleteAttachment(attachment.id)

    expect(attachment).toMatchObject({
      filename: 'report.xlsx',
      local_path: path,
      local_preview_url: path,
      status: 'ready',
    })
    expect(readChunk).not.toHaveBeenCalled()
    expect(desktopMocks.invoke).not.toHaveBeenCalled()
    expect(progress.mock.calls).toEqual([[0], [100]])
  })

  test('references a native picker file whose source path was retained', async () => {
    const file = new File(['# Context'], 'context.md', { type: 'text/markdown' })
    rememberNativeFilePath(file, '/Users/alice/Documents/context.md')

    const attachment = await createLocalAttachmentApi().uploadAttachment(file)

    expect(attachment.local_path).toBe('/Users/alice/Documents/context.md')
    expect(attachment.text_length).toBe(9)
    expect(desktopMocks.invoke).not.toHaveBeenCalled()
  })

  test('stores a generated file without a source path under executor home', async () => {
    desktopMocks.invoke
      .mockResolvedValueOnce({ uploadId: 'upload-1', chunkSize: 4 })
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce('/Users/me/.wework/workspace/attachments/draft/123/photo.png')
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' })
    const progress = vi.fn()

    const api = createLocalAttachmentApi()
    const attachment = await api.uploadAttachment(file, progress)

    expect(desktopMocks.invoke).toHaveBeenNthCalledWith(1, 'attachment.begin', {
      filename: 'photo.png',
      size: 3,
    })
    expect(desktopMocks.invoke).toHaveBeenNthCalledWith(3, 'attachment.finish', {
      uploadId: 'upload-1',
    })
    expect(progress).toHaveBeenNthCalledWith(1, 0)
    expect(progress).toHaveBeenNthCalledWith(2, 100)
    expect(attachment.local_path).toBe(
      '/Users/me/.wework/workspace/attachments/draft/123/photo.png'
    )
  })

  test('streams uploaded files to Electron in bounded chunks', async () => {
    desktopMocks.invoke.mockImplementation((capability: string) => {
      if (capability === 'attachment.begin') {
        return Promise.resolve({ uploadId: 'upload-1', chunkSize: 2 })
      }
      if (capability === 'attachment.append') {
        const call = desktopMocks.invoke.mock.calls.at(-1)
        const params = call?.[1] as { offset: number; chunkBase64: string }
        return Promise.resolve(
          params.offset +
            Uint8Array.from(atob(params.chunkBase64), value => value.charCodeAt(0)).byteLength
        )
      }
      if (capability === 'attachment.finish') {
        return Promise.resolve('/Users/me/.wework/workspace/attachments/draft/456/photo.png')
      }
      return Promise.reject(new Error(`Unexpected capability: ${capability}`))
    })
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', {
      type: 'image/png',
    })
    const progress = vi.fn()

    const attachment = await createLocalAttachmentApi().uploadAttachment(file, progress)

    expect(desktopMocks.invoke.mock.calls).toEqual([
      ['attachment.begin', { filename: 'photo.png', size: 3 }],
      [
        'attachment.append',
        {
          uploadId: 'upload-1',
          offset: 0,
          chunkBase64: 'AQI=',
        },
      ],
      [
        'attachment.append',
        {
          uploadId: 'upload-1',
          offset: 2,
          chunkBase64: 'Aw==',
        },
      ],
      ['attachment.finish', { uploadId: 'upload-1' }],
    ])
    expect(progress.mock.calls).toEqual([[0], [67], [100], [100]])
    expect(attachment.local_path).toBe(
      '/Users/me/.wework/workspace/attachments/draft/456/photo.png'
    )
  })

  test('aborts an Electron upload after a chunk failure', async () => {
    desktopMocks.invoke
      .mockResolvedValueOnce({ uploadId: 'upload-1', chunkSize: 2 })
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined)

    await expect(
      createLocalAttachmentApi().uploadAttachment(
        new File([new Uint8Array([1, 2, 3])], 'photo.png')
      )
    ).rejects.toThrow('disk full')
    expect(desktopMocks.invoke).toHaveBeenLastCalledWith('attachment.abort', {
      uploadId: 'upload-1',
    })
  })
})
