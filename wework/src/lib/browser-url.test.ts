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

  test('allows application assets only from the current Tauri origin', () => {
    expect(
      normalizeBrowserUrl(
        'tauri://localhost/extension-page.html?sessionId=123e4567-e89b-42d3-a456-426614174000',
        'tauri://localhost/'
      )
    ).toBe('tauri://localhost/extension-page.html?sessionId=123e4567-e89b-42d3-a456-426614174000')
    expect(
      normalizeBrowserUrl('tauri://other-host/extension-page.html', 'tauri://localhost/')
    ).toBe(null)
    expect(
      normalizeBrowserUrl('custom://localhost/extension-page.html', 'tauri://localhost/')
    ).toBe(null)
  })
})
