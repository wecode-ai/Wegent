import { expect, test } from 'vitest'
import { resolveMarkdownFilePath } from './workspaceFilePaths'

test.each([
  ['/workspace/reports/report.md', './截图.png', '/workspace/reports/截图.png'],
  [
    '/workspace/reports/report.md',
    '../images/screen shot.png',
    '/workspace/images/screen shot.png',
  ],
  ['/workspace/reports/report.md', '/tmp/image.png', '/tmp/image.png'],
  ['C:\\repo\\reports\\report.md', '..\\images\\截图.png', 'C:/repo/images/截图.png'],
  ['//server/share/reports/report.md', '../image.png', '//server/share/image.png'],
])('resolves %s link %s against the document directory', (document, link, expected) => {
  expect(resolveMarkdownFilePath(document, link)).toBe(expected)
})
