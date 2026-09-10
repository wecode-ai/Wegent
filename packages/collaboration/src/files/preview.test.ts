import { describe, expect, it } from 'vitest'
import { collaborationFilePreviewKind, isLikelyCollaborationTextContent } from './preview'

describe('collaboration file preview classification', () => {
  it('preserves text and binary extension handling', () => {
    expect(collaborationFilePreviewKind('src/main.zig', 'application/octet-stream')).toBe('unknown')
    expect(collaborationFilePreviewKind('README', 'application/octet-stream')).toBe('text')
    expect(collaborationFilePreviewKind('report.pdf', 'text/plain')).toBe('binary')
    expect(collaborationFilePreviewKind('data.bin', 'application/json')).toBe('text')
  })

  it('detects unknown UTF-8 text without treating binary bytes as text', () => {
    expect(isLikelyCollaborationTextContent(new TextEncoder().encode('const answer = 42'))).toBe(
      true
    )
    expect(isLikelyCollaborationTextContent(new Uint8Array([0, 1, 2, 3]))).toBe(false)
    expect(isLikelyCollaborationTextContent(new Uint8Array([0xff, 0xfe]))).toBe(false)
  })
})
