import { afterEach, describe, expect, test } from 'vitest'
import { resolvePluginAssetUrl } from './plugin-assets'

describe('resolvePluginAssetUrl', () => {
  test('routes local absolute and file logos through the scoped same-origin image endpoint', () => {
    const path = '/device/plugins/test-logo/assets/logo dark.svg'
    const expected = `/wework/executor/v1/plugin-image?path=${encodeURIComponent(path)}`
    expect(resolvePluginAssetUrl(path)).toBe(expected)
    expect(resolvePluginAssetUrl('file:///device/plugins/test-logo/assets/logo%20dark.svg')).toBe(
      expected
    )
    expect(resolvePluginAssetUrl('https://example.com/logo.svg')).toBe(
      'https://example.com/logo.svg'
    )
  })
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
  })
})
