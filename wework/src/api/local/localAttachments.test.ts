import { rememberNativeFilePath } from '@/desktop/nativeFilePaths'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createLocalAttachmentApi } from './localAttachments'

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
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
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

  test.each(['log'])(
    'references a large native %s file without reading or copying its contents',
    async extension => {
      const file = new File(['test data'], `large.${extension}`, { type: 'text/plain' })
      Object.defineProperty(file, 'size', { value: 378989795 })
      rememberNativeFilePath(file, `/Users/alice/large.${extension}`)
      const readText = vi.spyOn(file, 'text')
      const readBytes = vi.spyOn(file, 'arrayBuffer')
      const readChunk = vi.spyOn(file, 'slice')

      const attachment = await createLocalAttachmentApi().uploadAttachment(file)

      expect(attachment).toMatchObject({
        file_size: 378989795,
        local_path: `/Users/alice/large.${extension}`,
        text_length: null,
        status: 'ready',
      })
      expect(readText).not.toHaveBeenCalled()
      expect(readBytes).not.toHaveBeenCalled()
      expect(readChunk).not.toHaveBeenCalled()
      expect(desktopMocks.invoke).not.toHaveBeenCalled()
    }
  )

  test('starts staging a large generated file and reports the actual disk failure', async () => {
    const file = new File(['test data'], 'generated.txt')
    Object.defineProperty(file, 'size', { value: 100 * 1024 * 1024 + 1 })
    desktopMocks.invoke.mockRejectedValueOnce(new Error('disk full'))

    await expect(createLocalAttachmentApi().uploadAttachment(file)).rejects.toThrow('disk full')
    expect(desktopMocks.invoke).toHaveBeenCalledExactlyOnceWith(
      'attachment.begin',
      expect.objectContaining({
        filename: 'generated.txt',
        size: file.size,
        uploadId: expect.any(String),
      })
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
      [
        'attachment.begin',
        expect.objectContaining({ filename: 'photo.png', size: 3, uploadId: expect.any(String) }),
      ],
      [
        'attachment.append',
        expect.objectContaining({
          uploadId: 'upload-1',
          offset: 0,
          chunkBase64: 'AQI=',
          appendId: expect.any(String),
        }),
      ],
      [
        'attachment.append',
        expect.objectContaining({
          uploadId: 'upload-1',
          offset: 2,
          chunkBase64: 'Aw==',
          appendId: expect.any(String),
        }),
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

  test('uses the negotiated chunk size to stage a generated file in fewer host calls', async () => {
    const chunkSize = 2 * 1024 * 1024
    const file = new File([new Uint8Array(chunkSize + 1)], 'generated.bin')
    desktopMocks.invoke
      .mockResolvedValueOnce({ uploadId: 'upload-1', chunkSize })
      .mockResolvedValueOnce(chunkSize)
      .mockResolvedValueOnce(file.size)
      .mockResolvedValueOnce('/draft/generated.bin')

    const attachment = await createLocalAttachmentApi().uploadAttachment(file)

    const appends = desktopMocks.invoke.mock.calls.filter(([name]) => name === 'attachment.append')
    expect(appends.map(([, params]) => params.offset)).toEqual([0, chunkSize])
    expect(appends.map(([, params]) => atob(params.chunkBase64).length)).toEqual([chunkSize, 1])
    expect(attachment).toMatchObject({ status: 'ready', file_size: file.size })
  })

  test('preserves all byte values across the base64 encoding blocks', async () => {
    const bytes = Uint8Array.from({ length: 64 * 1024 + 1 }, (_, index) => index % 256)
    desktopMocks.invoke
      .mockResolvedValueOnce({ uploadId: 'upload-1', chunkSize: bytes.byteLength })
      .mockResolvedValueOnce(bytes.byteLength)
      .mockResolvedValueOnce('/draft/generated.bin')

    await createLocalAttachmentApi().uploadAttachment(new File([bytes], 'generated.bin'))

    expect(desktopMocks.invoke).toHaveBeenNthCalledWith(2, 'attachment.append', {
      uploadId: 'upload-1',
      offset: 0,
      appendId: expect.any(String),
      chunkBase64: Buffer.from(bytes).toString('base64'),
    })
  })

  test('retries attachment.finish when the host response is lost in transport', async () => {
    vi.useFakeTimers()
    const transportError = Object.assign(new Error('Electron host response was interrupted'), {
      name: 'DesktopHostTransportError',
    })
    desktopMocks.invoke.mockImplementation(async (capability: string) => {
      if (capability === 'attachment.begin') {
        return { uploadId: 'upload-1', chunkSize: 2 }
      }
      if (capability === 'attachment.append') return 1
      if (capability === 'attachment.finish') {
        if (desktopMocks.invoke.mock.calls.filter(([name]) => name === capability).length === 1) {
          throw transportError
        }
        return '/draft/recovered.bin'
      }
      throw new Error(`Unexpected capability: ${capability}`)
    })

    const upload = createLocalAttachmentApi().uploadAttachment(
      new File([new Uint8Array([1])], 'recovered.bin')
    )
    await vi.advanceTimersByTimeAsync(100)

    await expect(upload).resolves.toMatchObject({ local_path: '/draft/recovered.bin' })
    expect(
      desktopMocks.invoke.mock.calls.filter(([name]) => name === 'attachment.finish')
    ).toHaveLength(2)
  })

  test('retries an attachment chunk with the same append id after a lost response', async () => {
    vi.useFakeTimers()
    const transportError = Object.assign(new Error('Electron host response was interrupted'), {
      name: 'DesktopHostTransportError',
    })
    let appendAttempts = 0
    desktopMocks.invoke.mockImplementation(async (capability: string, params) => {
      if (capability === 'attachment.begin') {
        return { uploadId: params.uploadId, chunkSize: 2 }
      }
      if (capability === 'attachment.append') {
        appendAttempts += 1
        if (appendAttempts === 1) throw transportError
        return 1
      }
      if (capability === 'attachment.finish') return '/draft/recovered.bin'
      throw new Error(`Unexpected capability: ${capability}`)
    })

    const upload = createLocalAttachmentApi().uploadAttachment(
      new File([new Uint8Array([1])], 'recovered.bin')
    )
    await vi.advanceTimersByTimeAsync(100)

    await expect(upload).resolves.toMatchObject({ local_path: '/draft/recovered.bin' })
    const appends = desktopMocks.invoke.mock.calls.filter(
      ([capability]) => capability === 'attachment.append'
    )
    expect(appends).toHaveLength(2)
    expect(appends[0][1].appendId).toBe(appends[1][1].appendId)
    expect(appends[0][1].uploadId).toBe(appends[1][1].uploadId)
  })

  test('reports staging totals once without changing repeated progress or logging file data', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const file = new File([new Uint8Array(101)], 'private-name.bin')
    const slice = file.slice.bind(file)
    vi.spyOn(file, 'slice').mockImplementation((start, end, contentType) => {
      const chunk = slice(start, end, contentType)
      const read = chunk.arrayBuffer.bind(chunk)
      vi.spyOn(chunk, 'arrayBuffer').mockImplementation(async () => {
        clock += 2
        return read()
      })
      return chunk
    })
    const encode = btoa
    vi.spyOn(globalThis, 'btoa').mockImplementation(value => {
      clock += 3
      return encode(value)
    })
    desktopMocks.invoke.mockImplementation(async (capability, params) => {
      clock += 5
      if (capability === 'attachment.begin') {
        return { uploadId: 'private-upload-id', chunkSize: 1 }
      }
      if (capability === 'attachment.append') return params.offset + 1
      if (capability === 'attachment.finish') return '/private/path/private-name.bin'
      throw new Error(`Unexpected capability: ${capability}`)
    })
    const progress = vi.fn(() => {
      clock += 7
    })

    const attachment = await createLocalAttachmentApi().uploadAttachment(file, progress)

    expect(attachment.local_path).toBe('/private/path/private-name.bin')
    expect(progress.mock.calls).toEqual([
      [0],
      ...Array.from({ length: 101 }, (_, index) => [Math.round(((index + 1) / 101) * 100)]),
      [100],
    ])
    expect(debug).toHaveBeenCalledExactlyOnceWith(
      '[Wework] Electron host diagnostic ' +
        JSON.stringify({
          capability: 'attachment.staging',
          phase: 'completed',
          elapsedMs: 1727,
          readMs: 202,
          encodeMs: 303,
          invokeMs: 515,
          chunkCount: 101,
          progressChangeCount: 100,
        })
    )
    expect(debug.mock.calls[0][0]).not.toMatch(/private|uploadId|filename|path|chunkBase64/)
  })

  test.each(['attachment.begin', 'attachment.append', 'attachment.finish'])(
    'reports a %s failure once after cleanup without exposing its error',
    async failedCapability => {
      vi.stubEnv('VITE_WEWORK_E2E', 'true')
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
      const failure = new Error('private staging failure')
      desktopMocks.invoke.mockImplementation(async (capability, params) => {
        if (capability === failedCapability) throw failure
        if (capability === 'attachment.begin') return { uploadId: 'private-upload', chunkSize: 2 }
        if (capability === 'attachment.append') return params.offset + 1
        if (capability === 'attachment.abort') throw new Error('private abort failure')
        throw new Error(`Unexpected capability: ${capability}`)
      })

      await expect(
        createLocalAttachmentApi().uploadAttachment(new File(['a'], 'private-name.txt'))
      ).rejects.toBe(failure)

      expect(debug).toHaveBeenCalledTimes(1)
      const diagnostic = JSON.parse(
        debug.mock.calls[0][0].replace('[Wework] Electron host diagnostic ', '')
      )
      expect(diagnostic).toEqual({
        capability: 'attachment.staging',
        phase: 'failed',
        elapsedMs: expect.any(Number),
        readMs: expect.any(Number),
        encodeMs: expect.any(Number),
        invokeMs: expect.any(Number),
        chunkCount: failedCapability === 'attachment.begin' ? 0 : 1,
        progressChangeCount: failedCapability === 'attachment.finish' ? 1 : 0,
      })
      expect(debug.mock.calls[0][0]).not.toMatch(/private|uploadId|filename|path|failure/)
      if (failedCapability === 'attachment.begin') {
        expect(desktopMocks.invoke).toHaveBeenCalledTimes(1)
      } else {
        expect(desktopMocks.invoke).toHaveBeenLastCalledWith('attachment.abort', {
          uploadId: 'private-upload',
        })
      }
    }
  )

  test('keeps staging diagnostics disabled outside E2E', async () => {
    vi.stubEnv('MODE', 'test')
    vi.stubEnv('VITE_WEWORK_E2E', 'false')
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    desktopMocks.invoke.mockRejectedValueOnce(new Error('disk full'))

    await expect(
      createLocalAttachmentApi().uploadAttachment(new File(['a'], 'generated.txt'))
    ).rejects.toThrow('disk full')

    expect(debug).not.toHaveBeenCalled()
  })

  test.each([true, false])('a diagnostic output failure preserves staging success=%s', async ok => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {
      throw new Error('diagnostic failure')
    })
    const failure = new Error('staging failure')
    desktopMocks.invoke.mockImplementation(async capability => {
      if (capability === 'attachment.begin') {
        if (!ok) throw failure
        return { uploadId: 'upload-1', chunkSize: 2 }
      }
      if (capability === 'attachment.append') return 1
      if (capability === 'attachment.finish') return '/draft/generated.txt'
      throw new Error(`Unexpected capability: ${capability}`)
    })

    const upload = createLocalAttachmentApi().uploadAttachment(new File(['a'], 'generated.txt'))

    if (ok) await expect(upload).resolves.toMatchObject({ local_path: '/draft/generated.txt' })
    else await expect(upload).rejects.toBe(failure)
    expect(debug).toHaveBeenCalledTimes(1)
  })
})
