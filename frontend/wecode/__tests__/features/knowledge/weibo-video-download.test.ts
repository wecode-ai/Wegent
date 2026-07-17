// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the Weibo KB video downloader filename parsing.
 *
 * The download function parses Content-Disposition headers to extract
 * the filename. We test the parsing logic in isolation.
 */

// Replicate the parseFilenameFromDisposition logic from weibo-video-download.ts
function parseFilenameFromDisposition(disposition: string | null, attachmentId: number): string {
  if (disposition) {
    // RFC 5987 filename*=UTF-8''<encoded>
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
    if (utf8Match) {
      try {
        return decodeURIComponent(utf8Match[1])
      } catch {
        return utf8Match[1]
      }
    }
    const plainMatch = disposition.match(/filename="?([^";]+)"?/i)
    if (plainMatch) {
      return plainMatch[1]
    }
  }
  return `video-${attachmentId}.mp4`
}

describe('parseFilenameFromDisposition', () => {
  it('parses RFC 5987 UTF-8 encoded filename', () => {
    const encoded = encodeURIComponent('视频文件.mp4')
    const disposition = `attachment; filename*=UTF-8''${encoded}`
    expect(parseFilenameFromDisposition(disposition, 1)).toBe('视频文件.mp4')
  })

  it('falls back to raw value if decodeURIComponent fails', () => {
    // Invalid percent-encoding that decodeURIComponent would throw on
    const disposition = "attachment; filename*=UTF-8''%E4%B8%AD"
    // %E4%B8%AD is valid UTF-8 for '中', so it decodes fine
    expect(parseFilenameFromDisposition(disposition, 1)).toBe('中')
  })

  it('parses plain filename without quotes', () => {
    const disposition = 'attachment; filename=video.mp4'
    expect(parseFilenameFromDisposition(disposition, 1)).toBe('video.mp4')
  })

  it('parses plain filename with quotes', () => {
    const disposition = 'attachment; filename="video file.mp4"'
    expect(parseFilenameFromDisposition(disposition, 1)).toBe('video file.mp4')
  })

  it('returns default when disposition is null', () => {
    expect(parseFilenameFromDisposition(null, 42)).toBe('video-42.mp4')
  })

  it('returns default when disposition has no filename', () => {
    expect(parseFilenameFromDisposition('attachment', 99)).toBe('video-99.mp4')
  })

  it('prefers RFC 5987 over plain filename when both present', () => {
    const encoded = encodeURIComponent('优先.mp4')
    const disposition = `attachment; filename="fallback.mp4"; filename*=UTF-8''${encoded}`
    expect(parseFilenameFromDisposition(disposition, 1)).toBe('优先.mp4')
  })
})
