// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  loadBoundedRemoteFile,
  MAX_NON_RANGE_VIDEO_BYTES,
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
      status,
      headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? null,
      },
      body: { cancel },
    } as unknown as Response,
    cancel,
  }
}

function fileResponse(bytes: Uint8Array, headers: Record<string, string>) {
  let delivered = false
  const cancel = jest.fn().mockResolvedValue(undefined)
  const releaseLock = jest.fn()
  return {
    response: {
      ok: true,
      status: 200,
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
    })
    expect(global.fetch).toHaveBeenCalledWith(
      'https://cdn.example.com/video.mp4',
      expect.objectContaining({ headers: { Range: 'bytes=0-0' } })
    )
    expect(cancel).toHaveBeenCalled()
  })

  it('rejects a video over 20 MiB when the origin ignores Range', async () => {
    const { response, cancel } = videoResponse(200, {
      'content-length': String(MAX_NON_RANGE_VIDEO_BYTES + 1),
    })
    global.fetch = jest.fn().mockResolvedValue(response)

    await expect(
      probeRemoteVideo('https://cdn.example.com/video.mp4', new AbortController().signal)
    ).rejects.toMatchObject({ code: 'video-range-required' })
    expect(cancel).toHaveBeenCalled()
  })
})

describe('bounded remote file loading', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
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
})
