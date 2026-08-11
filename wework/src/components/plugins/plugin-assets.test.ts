import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  currentPluginLogoAppearanceMode,
  resolvePluginLogo,
  resolvePluginLogoUrl,
  resolvePreferredPluginLogo,
} from './plugin-assets'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`),
}))

describe('resolvePluginLogo', () => {
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

  test('uses a soft contrast pad in dark mode when logoDark is missing', () => {
    const result = resolvePluginLogo({
      pluginKey: 'documents',
      logo: 'https://cdn.example/logo-light.png',
      appearanceMode: 'dark',
    })
    expect(result).toEqual({
      url: 'https://cdn.example/logo-light.png',
      source: 'provided',
      contrastPad: true,
    })
  })

  test('ignores logoDark in light mode and never pads', () => {
    const result = resolvePluginLogo({
      pluginKey: 'documents',
      logo: 'https://cdn.example/logo-light.png',
      logoDark: 'https://cdn.example/logo-dark.png',
      appearanceMode: 'light',
    })
    expect(result).toEqual({
      url: 'https://cdn.example/logo-light.png',
      source: 'provided',
      contrastPad: false,
    })
  })

  test('returns an empty fallback so UI can show the name initial instead of wework.svg', () => {
    expect(
      resolvePluginLogo({
        pluginKey: 'github',
        appearanceMode: 'dark',
      })
    ).toEqual({
      url: '',
      source: 'fallback',
      contrastPad: false,
    })
    expect(
      resolvePluginLogoUrl({
        pluginKey: 'weibo-api-wiki',
        appearanceMode: 'light',
      })
    ).toBe('')
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

  test('reads appearance mode from the document theme attribute', () => {
    document.documentElement.dataset.theme = 'dark'
    expect(currentPluginLogoAppearanceMode()).toBe('dark')
    document.documentElement.dataset.theme = 'light'
    expect(currentPluginLogoAppearanceMode()).toBe('light')
  })

  test('prefers the first interface that yields a real package logo', () => {
    expect(
      resolvePreferredPluginLogo({
        pluginKey: 'sites',
        appearanceMode: 'light',
        interfaces: [{ logo: './assets/logo.png' }, { logo: 'data:image/png;base64,sites' }],
      })
    ).toEqual({
      url: 'data:image/png;base64,sites',
      source: 'provided',
      contrastPad: false,
    })
  })
})
