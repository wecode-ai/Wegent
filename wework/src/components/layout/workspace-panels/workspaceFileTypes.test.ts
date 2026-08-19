import { expect, test } from 'vitest'
import { isLikelyTextContent, isMarkdownFile, workspaceFilePreviewKind } from './workspaceFileTypes'

test.each([
  ['README.md', true],
  ['notes.MARKDOWN', true],
  ['archive.md.txt', false],
  ['document.txt', false],
])('detects Markdown file names for %s', (path, expected) => {
  expect(isMarkdownFile(path)).toBe(expected)
})

test.each([
  ['lib/main.dart', '', 'text'],
  ['src/App.vue', '', 'unknown'],
  ['Dockerfile.dev', '', 'text'],
  ['Makefile', '', 'text'],
  ['pubspec.lock', '', 'unknown'],
  ['schema.unknown', 'application/json', 'text'],
  ['diagram.puml', '', 'binary'],
  ['photo.png', 'image/png', 'binary'],
  ['archive.zip', 'application/zip', 'binary'],
  ['src/main.zig', '', 'unknown'],
  ['artifact.bin', 'application/octet-stream', 'unknown'],
])('detects previewable text files for %s', (path, contentType, expected) => {
  expect(workspaceFilePreviewKind(path, contentType)).toBe(expected)
})

test('detects UTF-8 text content for unknown file extensions', () => {
  expect(isLikelyTextContent(new TextEncoder().encode('const answer = 42\n'))).toBe(true)
})

test.each([
  new Uint8Array([0, 1, 2, 3]),
  new Uint8Array([0xff, 0xfe, 0xfd]),
  new Uint8Array([1, 2, 3, 4, 5]),
])('rejects binary content for unknown file extensions', bytes => {
  expect(isLikelyTextContent(bytes)).toBe(false)
})
