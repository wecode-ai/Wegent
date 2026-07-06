import { describe, expect, test } from 'vitest'
import { normalizeBrowserUrl } from './browser-url'

describe('browser URL helpers', () => {
  test('normalizes supported browser URLs', () => {
    expect(normalizeBrowserUrl('example.test')).toBe('https://example.test/')
    expect(normalizeBrowserUrl('https://example.test/mygroups?gid=1')).toBe(
      'https://example.test/mygroups?gid=1'
    )
    expect(normalizeBrowserUrl('ftp://example.com')).toBeNull()
  })
})
