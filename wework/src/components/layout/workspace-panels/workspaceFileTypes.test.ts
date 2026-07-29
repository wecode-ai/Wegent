import { expect, test } from 'vitest'
import { isMarkdownFile } from './workspaceFileTypes'

test.each([
  ['README.md', true],
  ['notes.MARKDOWN', true],
  ['archive.md.txt', false],
  ['document.txt', false],
])('detects Markdown file names for %s', (path, expected) => {
  expect(isMarkdownFile(path)).toBe(expected)
})
