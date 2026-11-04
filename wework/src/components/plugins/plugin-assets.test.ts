import { afterEach, describe, expect, test } from 'vitest'
import { resolvePluginAssetUrl, resolvePluginLogo } from './plugin-assets'

describe('resolvePluginLogo', () => {
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

  test('prefers logoDark in dark mode when provided', () => {
    const result = resolvePluginLogo({
      pluginKey: 'documents',
      logo: 'https://cdn.example/logo-light.png',
      logoDark: 'https://cdn.example/logo-dark.png',
      appearanceMode: 'dark',
    })
    expect(result).toEqual({
      url: 'https://cdn.example/logo-dark.png',
      source: 'provided',
      contrastPad: false,
    })
  })

  test('treats the host wework.svg icon as missing so personal plugins use initials', () => {
    expect(
      resolvePluginLogo({
        pluginKey: 'dev-tools',
        logo: '/plugin-icons/wework.svg',
        appearanceMode: 'light',
      })
    ).toEqual({
      url: '',
      source: 'fallback',
      contrastPad: false,
    })
  })
})
