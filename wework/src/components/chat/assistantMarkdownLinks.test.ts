import { describe, expect, test } from 'vitest'
import {
  classifyMarkdownLink,
  decodeMarkdownFilePath,
  desktopFileUrl,
  extractMarkdownLinks,
  localMarkdownImagePath,
} from './assistantMarkdownLinks'

describe('decodeMarkdownFilePath', () => {
  test('fully decodes a file path after repeated Markdown URL encoding', () => {
    const filePath = '/Users/dev/Library/Application Support/Wework/README file.md'
    const encodedPath = Array.from({ length: 8 }).reduce(
      currentPath => encodeURIComponent(currentPath),
      filePath
    )

    expect(decodeMarkdownFilePath(encodedPath)).toBe(filePath)
  })

  test('leaves the path unchanged when an encoded sequence is malformed', () => {
    expect(decodeMarkdownFilePath('/workspace/valid%20path/%E0%A4%A')).toBe(
      '/workspace/valid%20path/%E0%A4%A'
    )
  })
})

describe('classifyMarkdownLink', () => {
  test.each([
    ['/D:/研究课题/整体分层.sql', 'D:/研究课题/整体分层.sql'],
    ['/c:/', 'c:/'],
    [String.raw`/D:\研究课题\整体分层.sql`, String.raw`D:\研究课题\整体分层.sql`],
    ['/D%3A/研究课题/整体%2520分层.sql', 'D:/研究课题/整体 分层.sql'],
    ['file:///D:/研究课题/整体%20分层.sql', 'D:/研究课题/整体 分层.sql'],
  ])('normalizes the drive prefix in %s', (href, path) => {
    expect(classifyMarkdownLink(href)).toEqual({ kind: 'file', path })
  })

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

  test('classifies Windows drive-letter absolute paths as files', () => {
    expect(classifyMarkdownLink('C:/projects/example-app/wegent')).toEqual({
      kind: 'file',
      path: 'C:/projects/example-app/wegent',
    })
  })

  test('classifies backslash Windows drive-letter paths as files', () => {
    expect(classifyMarkdownLink('C:\\projects\\example-app\\wegent')).toEqual({
      kind: 'file',
      path: 'C:\\projects\\example-app\\wegent',
    })
  })

  test('keeps the line suffix on Windows drive-letter paths', () => {
    expect(classifyMarkdownLink('D:/repo/src/app.ts:42')).toEqual({
      kind: 'file',
      path: 'D:/repo/src/app.ts',
      lineStart: 42,
    })
  })

  test('classifies Windows drive-letter roots as files', () => {
    expect(classifyMarkdownLink('C:/')).toEqual({ kind: 'file', path: 'C:/' })
  })

  test('classifies lowercase Windows drive-letter paths as files', () => {
    expect(classifyMarkdownLink('d:/foo')).toEqual({ kind: 'file', path: 'd:/foo' })
  })

  test('classifies other schemes as external', () => {
    expect(classifyMarkdownLink('https://example.com/repo')).toEqual({ kind: 'external' })
    expect(classifyMarkdownLink('vscode://repo/path')).toEqual({ kind: 'external' })
  })

  test('classifies drive-relative paths without a separator as external', () => {
    expect(classifyMarkdownLink('D:relative/path')).toEqual({ kind: 'external' })
  })

  test('maps Sites environment configuration URLs into the Applications route', () => {
    expect(
      classifyMarkdownLink(
        '/projects/prj_01K0A0BCDEFGHJKMNPQRSTVWXY/settings/environment-variables'
      )
    ).toEqual({
      kind: 'internal',
      path: '/sites?app_type=web&view=environment-variables&project_id=prj_01K0A0BCDEFGHJKMNPQRSTVWXY',
    })
  })
})

test('normalizes slash-prefixed drive paths for images and browser file URLs', () => {
  expect(localMarkdownImagePath('/D:/研究课题/plot%20one.png')).toBe('D:/研究课题/plot one.png')
  expect(desktopFileUrl('/D:/研究课题/report one.html')).toBe(
    'file:///D:/%E7%A0%94%E7%A9%B6%E8%AF%BE%E9%A2%98/report%20one.html'
  )
})

describe('extractMarkdownLinks', () => {
  test('supports balanced destinations, angle brackets, and optional titles', () => {
    expect(
      extractMarkdownLinks(
        '[version](https://example.com/page_(v2)) [local](</workspace/a b.md> "Document")'
      )
    ).toEqual([
      { href: 'https://example.com/page_(v2)', title: 'version' },
      { href: '/workspace/a b.md', title: 'local' },
    ])
  })
})
