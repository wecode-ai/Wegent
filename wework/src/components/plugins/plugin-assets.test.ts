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
    })
  })

  test('falls back to logo in dark mode when logoDark is missing', () => {
    const result = resolvePluginLogo({
      pluginKey: 'documents',
      logo: 'https://cdn.example/logo-light.png',
      appearanceMode: 'dark',
    })
    expect(result).toMatchObject({
      url: 'https://cdn.example/logo-light.png',
      source: 'provided',
    })
  })

  test('ignores logoDark in light mode', () => {
    const result = resolvePluginLogo({
      pluginKey: 'documents',
      logo: 'https://cdn.example/logo-light.png',
      logoDark: 'https://cdn.example/logo-dark.png',
      appearanceMode: 'light',
    })
    expect(result).toMatchObject({
      url: 'https://cdn.example/logo-light.png',
      source: 'provided',
    })
  })

  test('uses github dark fallback icon in dark mode', () => {
    expect(
      resolvePluginLogoUrl({
        pluginKey: 'github',
        appearanceMode: 'dark',
      })
    ).toBe('/plugin-icons/github-dark.svg')
    expect(
      resolvePluginLogoUrl({
        pluginKey: 'github',
        appearanceMode: 'light',
      })
    ).toBe('/plugin-icons/github.svg')
  })

  test('reads appearance mode from the document theme attribute', () => {
    document.documentElement.dataset.theme = 'dark'
    expect(currentPluginLogoAppearanceMode()).toBe('dark')
    document.documentElement.dataset.theme = 'light'
    expect(currentPluginLogoAppearanceMode()).toBe('light')
  })
})
