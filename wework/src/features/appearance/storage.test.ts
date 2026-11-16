import { beforeEach, describe, expect, test } from 'vitest'
import { defaultThemeAppearance } from '@wegent/collaboration/theme'
import { defaultAppearance } from './presets'
import { mergeAppearance, readStoredAppearance, writeStoredAppearance } from './storage'

describe('appearance persistence', () => {
  beforeEach(() => localStorage.clear())

  test('uses Wework defaults for new or unreadable preferences', () => {
    expect(readStoredAppearance()).toMatchObject({
      lightThemeId: 'wework',
      darkThemeId: 'wework',
      mode: 'system',
      accentColor: '#2563eb',
    })
    localStorage.setItem('wework.appearance', '{invalid')
    expect(readStoredAppearance()).toEqual(defaultAppearance)
  })

  test('migrates old default palette snapshots without pinning preset colors', () => {
    const appearance = mergeAppearance({
      mode: 'dark',
      light: defaultThemeAppearance.light,
      dark: defaultThemeAppearance.dark,
      accentColor: '#2563eb',
      uiFontSize: 16,
      backgroundImagePath: 'C:\\Pictures\\background.png',
      backgroundVisibility: 35,
    })
    expect(appearance.themeOverrides).toEqual({ light: {}, dark: {} })
    expect(appearance.lightThemeId).toBe('wework')
    expect(appearance.darkThemeId).toBe('wework')
    expect(appearance.light).toEqual(defaultThemeAppearance.light)
    expect(appearance.dark).toEqual(defaultThemeAppearance.dark)
    expect(appearance.uiFontSize).toBe(16)
    expect(appearance.backgroundImagePath).toBe('C:\\Pictures\\background.png')
    expect(appearance.backgroundVisibility).toBe(35)
  })

  test('retains deliberate legacy palette and accent edits as explicit overrides', () => {
    const appearance = mergeAppearance({
      mode: 'dark',
      accentColor: '#123456',
      dark: { ...defaultThemeAppearance.dark, bgBase: '1 2 3' },
    })
    expect(appearance.themeOverrides.dark).toEqual({
      accentColor: '#123456',
      palette: { bgBase: '1 2 3' },
    })
    expect(appearance.dark.bgBase).toBe('1 2 3')
  })

  test('persists theme identities instead of expanded palettes and restores overrides', () => {
    const appearance = mergeAppearance({
      ...defaultAppearance,
      mode: 'dark',
      darkThemeId: 'tokyo-night',
      lightThemeId: 'proof',
      themeOverrides: { dark: { accentColor: '#abcdef' }, light: {} },
    })
    writeStoredAppearance(appearance)
    const stored = JSON.parse(localStorage.getItem('wework.appearance')!)
    expect(stored.schemaVersion).toBe(2)
    expect(stored.darkThemeId).toBe('tokyo-night')
    expect(stored.lightThemeId).toBe('proof')
    expect(stored).not.toHaveProperty('light')
    expect(stored).not.toHaveProperty('dark')
    expect(stored).not.toHaveProperty('accentColor')
    expect(readStoredAppearance().accentColor).toBe('#abcdef')
    expect(readStoredAppearance().dark.bgBase).toBe('26 27 38')
  })

  test('retains explicitly saved ChatGPT selections when the default changes', () => {
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({
        schemaVersion: 2,
        mode: 'dark',
        lightThemeId: 'codex',
        darkThemeId: 'codex',
        themeOverrides: { dark: { accentColor: '#abcdef' } },
      })
    )
    const appearance = readStoredAppearance()
    expect(appearance.lightThemeId).toBe('codex')
    expect(appearance.darkThemeId).toBe('codex')
    expect(appearance.dark.bgBase).toBe('17 17 17')
    expect(appearance.accentColor).toBe('#abcdef')
  })

  test('normalizes unsupported variants and rejects invalid color values', () => {
    const appearance = mergeAppearance({
      ...defaultAppearance,
      lightThemeId: 'tokyo-night',
      darkThemeId: 'proof',
      themeOverrides: {
        dark: {
          accentColor: 'invalid',
          palette: { bgBase: '999 1 1', border: 'red;display:none' },
        },
      },
    })
    expect(appearance.lightThemeId).toBe('wework')
    expect(appearance.darkThemeId).toBe('wework')
    expect(appearance.themeOverrides.dark).toEqual({})
  })

  test('keeps the native window canvas opaque when reading saved overrides', () => {
    const appearance = mergeAppearance({
      ...defaultAppearance,
      themeOverrides: { dark: { palette: { bgBase: '1 2 3 / 0.8', sidebar: '4 5 6 / 0.8' } } },
    })
    expect(appearance.themeOverrides.dark.palette).toEqual({ sidebar: '4 5 6 / 0.8' })
  })
})
