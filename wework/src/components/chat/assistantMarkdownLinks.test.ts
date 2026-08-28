import { describe, expect, test } from 'vitest'
import { decodeMarkdownFilePath } from './assistantMarkdownLinks'

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
