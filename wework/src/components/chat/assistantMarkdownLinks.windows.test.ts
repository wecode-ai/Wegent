import { expect, test } from 'vitest'
import {
  classifyMarkdownLink,
  desktopFileUrl,
  localMarkdownImagePath,
  transformMarkdownUrl,
} from './assistantMarkdownLinks'

test.each([
  ['/D:/研究课题/整体分层.sql', 'D:/研究课题/整体分层.sql'],
  ['/c:/', 'c:/'],
  [String.raw`/D:\研究课题\整体分层.sql`, String.raw`D:\研究课题\整体分层.sql`],
  ['/D%3A/研究课题/整体%2520分层.sql', 'D:/研究课题/整体 分层.sql'],
  ['file:///D:/研究课题/整体%20分层.sql', 'D:/研究课题/整体 分层.sql'],
  ['D:%5Cproject%5Ccart-review.md', String.raw`D:\project\cart-review.md`],
  ['D:%255Cproject%255Ccart-review.md', String.raw`D:\project\cart-review.md`],
  ['D:%2Fproject%2Fcart-review.md', 'D:/project/cart-review.md'],
])('normalizes the drive prefix in %s', (href, path) => {
  expect(classifyMarkdownLink(href)).toEqual({ kind: 'file', path })
})

test.each(['javascript:%5Calert(1)', 'https://example.com/report.md', 'D:relative.md'])(
  'does not reinterpret a non-file protocol as an absolute drive path: %s',
  href => expect(classifyMarkdownLink(href)).toEqual({ kind: 'external' })
)

test.each([
  'javascript:%5Calert(1)',
  'javascript%3Aalert(1)',
  'data:text/html,hello',
  'vbscript:run',
])('keeps unsafe Markdown hrefs blocked: %s', href =>
  expect(transformMarkdownUrl(href, 'href')).toBeUndefined()
)

test('preserves line ranges when normalizing a slash-prefixed drive path', () => {
  expect(classifyMarkdownLink('/D:/研究课题/整体分层.sql:12-20')).toEqual({
    kind: 'file',
    path: 'D:/研究课题/整体分层.sql',
    lineStart: 12,
    lineEnd: 20,
  })
})

test('normalizes folder links using the same drive-path rules', () => {
  expect(classifyMarkdownLink('folder:///D:/研究课题')).toEqual({
    kind: 'file',
    path: 'D:/研究课题',
    isDirectory: true,
  })
})

test.each(['/workspace/report.sql', '/D:relative/report.sql', '//server/share/report.sql'])(
  'preserves a path without a slash-prefixed absolute drive: %s',
  path => {
    expect(classifyMarkdownLink(path)).toEqual({ kind: 'file', path })
  }
)

test('normalizes slash-prefixed drive paths for images and browser file URLs', () => {
  expect(localMarkdownImagePath('/D:/研究课题/plot%20one.png')).toBe('D:/研究课题/plot one.png')
  expect(desktopFileUrl('/D:/研究课题/report one.html')).toBe(
    'file:///D:/%E7%A0%94%E7%A9%B6%E8%AF%BE%E9%A2%98/report%20one.html'
  )
})
