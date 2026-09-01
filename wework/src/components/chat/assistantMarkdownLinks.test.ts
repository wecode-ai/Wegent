import { describe, expect, test } from 'vitest'
import { classifyMarkdownLink, decodeMarkdownFilePath } from './assistantMarkdownLinks'

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
})
