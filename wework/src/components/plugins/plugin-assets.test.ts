import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  currentPluginLogoAppearanceMode,
  resolvePluginLogo,
  resolvePluginLogoUrl,
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
    expect(result).toMatchObject({
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
    expect(result).toMatchObject({
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
    expect(result).toMatchObject({
      url: 'https://cdn.example/logo-light.png',
      source: 'provided',
      contrastPad: false,
    })
  })

  test('uses the neutral default icon without a contrast pad when the package has no logo', () => {
    expect(
      resolvePluginLogo({
        pluginKey: 'github',
        appearanceMode: 'dark',
      })
    ).toEqual({
      url: '/plugin-icons/wework.svg',
      source: 'fallback',
      contrastPad: false,
    })
    expect(
      resolvePluginLogoUrl({
        pluginKey: 'github',
        appearanceMode: 'light',
      })
    ).toBe('/plugin-icons/wework.svg')
  })

  test('reads appearance mode from the document theme attribute', () => {
    document.documentElement.dataset.theme = 'dark'
    expect(currentPluginLogoAppearanceMode()).toBe('dark')
    document.documentElement.dataset.theme = 'light'
    expect(currentPluginLogoAppearanceMode()).toBe('light')
  })
})
