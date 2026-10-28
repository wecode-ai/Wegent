// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { TextDecoder as NodeTextDecoder } from 'node:util'

import {
  loadBoundedRemoteFile,
  MAX_NON_RANGE_VIDEO_BYTES,
  prepareRemotePdf,
  probeRemoteVideo,
} from '@/features/knowledge/document/utils/boundedRemoteFile'
import { resolveDocumentLinkPolicy } from '@/features/knowledge/document/utils/documentLinkPolicy'
import {
  createDocumentLinkResource,
  getDocumentLinkKind,
  isDocumentFileLink,
} from '@/features/knowledge/document/utils/documentLinkResource'

function documentSource(
  provider?: string,
  responseProvider?: string
): Parameters<typeof resolveDocumentLinkPolicy>[0] {
  return {
    source_type: provider ? 'external' : 'file',
    source_config: provider ? { external: { provider } } : {},
    external_provider: responseProvider,
  }
}

function videoResponse(status: number, headers: Record<string, string>) {
  const cancel = jest.fn().mockResolvedValue(undefined)
  return {
    response: {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? null,
      },
      body: { cancel },
    } as unknown as Response,
    cancel,
  }
}

function fileResponse(bytes: Uint8Array, headers: Record<string, string>, status = 200) {
  let delivered = false
  const cancel = jest.fn().mockResolvedValue(undefined)
  const releaseLock = jest.fn()
  return {
    response: {
      ok: true,
      status,
      headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? null,
      },
      body: {
        cancel,
        getReader: () => ({
          read: jest.fn(async () => {
            if (delivered) return { done: true, value: undefined }
            delivered = true
            return { done: false, value: bytes }
          }),
          cancel,
          releaseLock,
        }),
      },
    } as unknown as Response,
    cancel,
  }
}

describe('DingTalk document link preview policy', () => {
  it('preserves non-DingTalk behavior based only on the document source', () => {
    for (const source of [
      documentSource(),
      { ...documentSource(), source_type: 'text' as const },
      documentSource('wiki', 'wiki'),
      documentSource('wiki', 'notion'),
    ]) {
      expect(resolveDocumentLinkPolicy(source)).toEqual({ policy: 'legacy' })
    }
    expect(resolveDocumentLinkPolicy(documentSource('dingtalk'))).toEqual({
      policy: 'preview-only',
      reason: 'dingtalk-source',
    })
  })

  it('restricts DingTalk documents while preserving regular document links', () => {
    expect(resolveDocumentLinkPolicy(documentSource('dingtalk', 'dingtalk'))).toEqual({
      policy: 'preview-only',
      reason: 'dingtalk-source',
    })
    expect(resolveDocumentLinkPolicy(documentSource())).toEqual({ policy: 'legacy' })
  })

  it('fails closed when source metadata conflicts', () => {
    expect(resolveDocumentLinkPolicy(documentSource('dingtalk', 'notion'))).toEqual({
      policy: 'unavailable',
      reason: 'source-conflict',
    })
  })

  it('recognizes supported resources and rejects unsafe transport', () => {
    expect(getDocumentLinkKind('https://cdn.example.com/file.pdf?token=1')).toBe('pdf')
    expect(getDocumentLinkKind('https://cdn.example.com/video.mp4')).toBe('video')
    expect(getDocumentLinkKind('https://cdn.example.com/animation.gif')).toBe('image')
    expect(getDocumentLinkKind('files/%E6%96%87%E6%A1%A3.PDF')).toBe('pdf')
    expect(isDocumentFileLink('https://cdn.example.com/animation.gif')).toBe(true)
    expect(isDocumentFileLink('../files/report.docx#section')).toBe(true)
    expect(createDocumentLinkResource(1149, 'http://cdn.example.com/video.mp4')).toBeNull()
    expect(
      createDocumentLinkResource(1149, 'https://cdn.example.com/file.pdf?Expires=2000000000')
    ).toMatchObject({
      documentId: 1149,
      filename: 'file.pdf',
      kindHint: 'pdf',
      expiresAt: 2_000_000_000_000,
    })
  })
})

describe('remote video range probe', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('accepts a large video when the origin supports byte ranges', async () => {
    const { response, cancel } = videoResponse(206, {
      'content-range': `bytes 0-0/${MAX_NON_RANGE_VIDEO_BYTES * 2}`,
      'content-length': '1',
    })
    global.fetch = jest.fn().mockResolvedValue(response)

    await expect(
      probeRemoteVideo('https://cdn.example.com/video.mp4', new AbortController().signal)
    ).resolves.toEqual({
      size: MAX_NON_RANGE_VIDEO_BYTES * 2,
      supportsRange: true,
      validation: 'verified',
    })
    expect(global.fetch).toHaveBeenCalledWith(
      'https://cdn.example.com/video.mp4',
      expect.objectContaining({ headers: { Range: 'bytes=0-0' } })
    )
    expect(cancel).toHaveBeenCalled()
  })

  it('rejects a video over the non-range limit when the origin ignores Range', async () => {
    const { response, cancel } = videoResponse(200, {
      'content-length': String(MAX_NON_RANGE_VIDEO_BYTES + 1),
    })
    global.fetch = jest.fn().mockResolvedValue(response)

    await expect(
      probeRemoteVideo('https://cdn.example.com/video.mp4', new AbortController().signal)
    ).rejects.toMatchObject({ code: 'video-range-required' })
    expect(cancel).toHaveBeenCalled()
  })

  it.each([204, 429, 500, 503])(
    'rejects an HTTP %i response instead of mounting media',
    async status => {
      const { response, cancel } = videoResponse(status, {})
      global.fetch = jest.fn().mockResolvedValue(response)

      await expect(
        probeRemoteVideo('https://cdn.example.com/video.mp4', new AbortController().signal)
      ).rejects.toMatchObject({ code: 'network-or-cors' })
      expect(cancel).toHaveBeenCalled()
    }
  )

  it('uses native playback when a 206 response hides Content-Range', async () => {
    const { response, cancel } = videoResponse(206, { 'content-length': '1' })
    global.fetch = jest.fn().mockResolvedValue(response)

    await expect(
      probeRemoteVideo('https://cdn.example.com/video.mp4', new AbortController().signal)
    ).resolves.toEqual({ supportsRange: false, validation: 'native-fallback' })
    expect(cancel).toHaveBeenCalled()
  })

  it('labels a CORS-unreadable video as a native fallback instead of verified', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(
      probeRemoteVideo('https://cdn.example.com/video.mp4', new AbortController().signal)
    ).resolves.toEqual({ supportsRange: false, validation: 'native-fallback' })
  })

  it('does not report a non-range video with a hidden size as verified', async () => {
    const { response, cancel } = videoResponse(200, {})
    global.fetch = jest.fn().mockResolvedValue(response)

    await expect(
      probeRemoteVideo('https://cdn.example.com/video.mp4', new AbortController().signal)
    ).resolves.toEqual({ supportsRange: false, validation: 'native-fallback' })
    expect(cancel).toHaveBeenCalled()
  })
})

describe('bounded remote file loading', () => {
  const originalFetch = global.fetch
  const originalTextDecoder = global.TextDecoder

  beforeAll(() => {
    Object.defineProperty(global, 'TextDecoder', {
      configurable: true,
      value: NodeTextDecoder,
    })
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  afterAll(() => {
    Object.defineProperty(global, 'TextDecoder', {
      configurable: true,
      value: originalTextDecoder,
    })
  })

  it('rejects an image whose decoded pixel dimensions exceed the budget', async () => {
    const png = new Uint8Array(24)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const view = new DataView(png.buffer)
    view.setUint32(16, 5_000)
    view.setUint32(20, 5_000)
    const { response } = fileResponse(png, {
      'content-type': 'image/png',
      'content-length': String(png.length),
    })
    global.fetch = jest.fn().mockResolvedValue(response)

    await expect(
      loadBoundedRemoteFile(
        'https://cdn.example.com/large.png',
        'image',
        new AbortController().signal,
        'large.png'
      )
    ).rejects.toMatchObject({ code: 'too-complex' })
  })

  it('rejects HTML returned by a URL that looks like a PDF', async () => {
    const html = Uint8Array.from('<html>login</html>', character => character.charCodeAt(0))
    const { response } = fileResponse(html, {
      'content-type': 'text/html',
      'content-length': String(html.length),
    })
    global.fetch = jest.fn().mockResolvedValue(response)

    await expect(
      loadBoundedRemoteFile(
        'https://cdn.example.com/file.pdf',
        'pdf',
        new AbortController().signal,
        'file.pdf'
      )
    ).rejects.toMatchObject({ code: 'unsupported-type' })
  })

  it('accepts a GIF whose signature and dimensions fit the image budget', async () => {
    const gif = new Uint8Array(10)
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    const view = new DataView(gif.buffer)
    view.setUint16(6, 320, true)
    view.setUint16(8, 240, true)
    const { response } = fileResponse(gif, {
      'content-type': 'image/gif',
      'content-length': String(gif.length),
    })
    global.fetch = jest.fn().mockResolvedValue(response)

    await expect(
      loadBoundedRemoteFile(
        'https://cdn.example.com/animation.gif',
        'image',
        new AbortController().signal,
        'animation.gif'
      )
    ).resolves.toMatchObject({ mimeType: 'image/gif', size: gif.length })
  })

  it('reads the full VP8L height bit field when enforcing the pixel budget', async () => {
    const webp = new Uint8Array(25)
    webp.set(
      Uint8Array.from('RIFF', character => character.charCodeAt(0)),
      0
    )
    webp.set(
      Uint8Array.from('WEBPVP8L', character => character.charCodeAt(0)),
      8
    )
    webp[20] = 0x2f
    const width = 4_000
    const height = 4_000
    const packed = (width - 1) | ((height - 1) << 14) | (1 << 28)
    new DataView(webp.buffer).setUint32(21, packed, true)
    const { response } = fileResponse(webp, {
      'content-type': 'image/webp',
      'content-length': String(webp.length),
    })
    global.fetch = jest.fn().mockResolvedValue(response)

    await expect(
      loadBoundedRemoteFile(
        'https://cdn.example.com/large.webp',
        'image',
        new AbortController().signal,
        'large.webp'
      )
    ).rejects.toMatchObject({ code: 'too-complex' })
  })

  it('accepts a JPEG whose SOF marker follows a large APP segment', async () => {
    const jpeg = new Uint8Array(65_550)
    jpeg.set([0xff, 0xd8, 0xff, 0xe1])
    const view = new DataView(jpeg.buffer)
    view.setUint16(4, 65_535)
    const sofOffset = 65_539
    jpeg.set([0xff, 0xc0], sofOffset)
    view.setUint16(sofOffset + 2, 7)
    jpeg[sofOffset + 4] = 8
    view.setUint16(sofOffset + 5, 100)
    view.setUint16(sofOffset + 7, 100)
    const { response } = fileResponse(jpeg, {
      'content-type': 'image/jpeg',
      'content-length': String(jpeg.length),
    })
    global.fetch = jest.fn().mockResolvedValue(response)

    await expect(
      loadBoundedRemoteFile(
        'https://cdn.example.com/photo.jpg',
        'image',
        new AbortController().signal,
        'photo.jpg'
      )
    ).resolves.toMatchObject({ mimeType: 'image/jpeg', size: jpeg.length })
  })
})

describe('remote PDF preparation', () => {
  const originalFetch = global.fetch
  const pdfPrefix = Uint8Array.from('%PDF-1.7\nfixture', character => character.charCodeAt(0))

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('streams a large PDF directly after a bounded range and signature check', async () => {
    const size = 36 * 1024 * 1024
    const { response } = fileResponse(
      pdfPrefix,
      {
        'content-type': 'application/pdf',
        'content-length': String(pdfPrefix.length),
        'content-range': `bytes 0-${pdfPrefix.length - 1}/${size}`,
      },
      206
    )
    global.fetch = jest.fn().mockResolvedValue(response)

    await expect(
      prepareRemotePdf(
        'https://cdn.example.com/large.pdf',
        new AbortController().signal,
        'large.pdf'
      )
    ).resolves.toEqual({
      mimeType: 'application/pdf',
      size,
      supportsRange: true,
      validatedUrl: 'https://cdn.example.com/large.pdf',
    })
    expect(global.fetch).toHaveBeenCalledWith(
      'https://cdn.example.com/large.pdf',
      expect.objectContaining({ headers: { Range: 'bytes=0-15' } })
    )
  })

  it('buffers a small PDF only when the origin ignores Range', async () => {
    const first = fileResponse(pdfPrefix, {
      'content-type': 'application/pdf',
      'content-length': String(pdfPrefix.length),
    })
    const second = fileResponse(pdfPrefix, {
      'content-type': 'application/pdf',
      'content-length': String(pdfPrefix.length),
    })
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response)

    await expect(
      prepareRemotePdf(
        'https://cdn.example.com/small.pdf',
        new AbortController().signal,
        'small.pdf'
      )
    ).resolves.toMatchObject({
      mimeType: 'application/pdf',
      size: pdfPrefix.length,
      supportsRange: false,
    })
  })

  it('falls back to the bounded loader when CORS hides Content-Range', async () => {
    const first = fileResponse(
      pdfPrefix,
      {
        'content-type': 'application/pdf',
        'content-length': String(pdfPrefix.length),
      },
      206
    )
    const second = fileResponse(pdfPrefix, {
      'content-type': 'application/pdf',
      'content-length': String(pdfPrefix.length),
    })
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response)

    await expect(
      prepareRemotePdf(
        'https://cdn.example.com/hidden-range.pdf',
        new AbortController().signal,
        'hidden-range.pdf'
      )
    ).resolves.toMatchObject({
      mimeType: 'application/pdf',
      size: pdfPrefix.length,
      supportsRange: false,
    })
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(first.cancel).toHaveBeenCalled()
  })

  it('does not treat a 206 fragment Content-Length as the total file size', async () => {
    const first = fileResponse(
      pdfPrefix,
      {
        'content-type': 'application/pdf',
        'content-length': String(pdfPrefix.length),
      },
      206
    )
    const second = fileResponse(pdfPrefix, {
      'content-type': 'application/pdf',
      'content-length': String(pdfPrefix.length),
    })
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response)

    await expect(
      prepareRemotePdf(
        'https://cdn.example.com/partial.pdf',
        new AbortController().signal,
        'partial.pdf'
      )
    ).resolves.toMatchObject({
      supportsRange: false,
    })
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(first.cancel).toHaveBeenCalled()
  })

  it('reports a PDF shorter than its signature as unsupported instead of a CORS error', async () => {
    const short = Uint8Array.from([0x25, 0x50, 0x44, 0x46])
    const range = fileResponse(
      short,
      {
        'content-type': 'application/pdf',
        'content-length': String(short.length),
        'content-range': `bytes 0-${short.length - 1}/${short.length}`,
      },
      206
    )
    global.fetch = jest.fn().mockResolvedValue(range.response)

    await expect(
      prepareRemotePdf(
        'https://cdn.example.com/short.pdf',
        new AbortController().signal,
        'short.pdf'
      )
    ).rejects.toMatchObject({ code: 'unsupported-type' })
  })

  it('rejects a server that returns an oversized 206 body for the bounded range', async () => {
    const bytes = new Uint8Array(32)
    bytes.set(pdfPrefix)
    const range = fileResponse(
      bytes,
      {
        'content-type': 'application/pdf',
        'content-length': String(bytes.length),
        'content-range': `bytes 0-${bytes.length - 1}/${36 * 1024 * 1024}`,
      },
      206
    )
    global.fetch = jest.fn().mockResolvedValue(range.response)

    await expect(
      prepareRemotePdf(
        'https://cdn.example.com/unbounded.pdf',
        new AbortController().signal,
        'unbounded.pdf'
      )
    ).rejects.toMatchObject({ code: 'network-or-cors' })
  })

  it('rejects a range response whose total size cannot be verified', async () => {
    const range = fileResponse(
      pdfPrefix,
      {
        'content-type': 'application/pdf',
      },
      206
    )
    global.fetch = jest.fn().mockResolvedValue(range.response)

    await expect(
      prepareRemotePdf(
        'https://cdn.example.com/unknown-size.pdf',
        new AbortController().signal,
        'unknown-size.pdf'
      )
    ).rejects.toMatchObject({ code: 'network-or-cors' })
  })

  it('rejects an oversized PDF when the origin ignores Range without buffering it', async () => {
    const { response, cancel } = fileResponse(pdfPrefix, {
      'content-type': 'application/pdf',
      'content-length': String(MAX_NON_RANGE_VIDEO_BYTES + 1),
    })
    global.fetch = jest.fn().mockResolvedValue(response)

    await expect(
      prepareRemotePdf(
        'https://cdn.example.com/large-no-range.pdf',
        new AbortController().signal,
        'large-no-range.pdf'
      )
    ).rejects.toMatchObject({ code: 'too-large' })
    expect(cancel).toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})
