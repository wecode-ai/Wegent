// @vitest-environment node

import { expect, test } from 'vitest'
import { isLikelyTextContent, isMarkdownFile, workspaceFilePreviewKind } from './workspaceFileTypes'

test.each([['archive.md.txt', false]])('detects Markdown file names for %s', (path, expected) => {
  expect(isMarkdownFile(path)).toBe(expected)
})

test.each([['archive.zip', 'application/zip', 'binary']])(
  'detects previewable text files for %s',
  (path, contentType, expected) => {
    expect(workspaceFilePreviewKind(path, contentType)).toBe(expected)
  }
)

test.each([
  new Uint8Array([0, 1, 2, 3]),
  new Uint8Array([0xff, 0xfe, 0xfd]),
  new Uint8Array([1, 2, 3, 4, 5]),
])('rejects binary content for unknown file extensions', bytes => {
  expect(isLikelyTextContent(bytes)).toBe(false)
})
