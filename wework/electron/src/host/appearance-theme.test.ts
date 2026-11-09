import { describe, expect, test, vi } from 'vitest'
import { normalizeAppearanceThemeSnapshot } from './appearance-theme-contract.js'
import { DesktopAppearanceController, resolveHostAppearance } from './appearance-theme.js'

const snapshot = {
  light: {
    themeId: 'github',
    variables: { '--color-bg-base': '255 255 255', '--color-text-primary': '31 35 40' },
  },
  dark: {
    themeId: 'tokyo-night',
    variables: { '--color-bg-base': '26 27 38', '--color-text-primary': '192 202 245' },
  },
}

describe('desktop appearance snapshot', () => {
  test('resolves both persisted palettes against the current system appearance', () => {
    const preferences = { appearanceMode: 'system', appearanceThemeSnapshot: snapshot }

    expect(resolveHostAppearance(preferences, true)).toMatchObject({
      mode: 'dark',
      themeId: 'tokyo-night',
      backgroundColor: '#1a1b26',
      variables: snapshot.dark.variables,
    })
    expect(resolveHostAppearance(preferences, false)).toMatchObject({
      mode: 'light',
      themeId: 'github',
      backgroundColor: '#ffffff',
    })
  })

  test('honors explicit mode before a native theme update and handles missing snapshots', () => {
    expect(
      resolveHostAppearance({ appearanceMode: 'light', appearanceThemeSnapshot: snapshot }, true)
    ).toMatchObject({ mode: 'light', themeId: 'github', backgroundColor: '#ffffff' })
    expect(resolveHostAppearance({ appearanceMode: 'dark' }, false)).toMatchObject({
      mode: 'dark',
      themeId: 'wework',
      backgroundColor: '#181818',
      variables: { '--color-primary': '37 99 235' },
    })
    expect(resolveHostAppearance({}, false)).toMatchObject({
      mode: 'light',
      themeId: 'wework',
      backgroundColor: '#ffffff',
      variables: { '--color-bg-surface': '247 247 248', '--color-primary': '37 99 235' },
    })
  })

  test.each([
    null,
    { light: snapshot.light },
    { ...snapshot, dark: { ...snapshot.dark, variables: { '--color-bg-base': '300 0 0' } } },
    { ...snapshot, dark: { ...snapshot.dark, variables: { '--color-bg-base': '#1a1b26' } } },
    {
      ...snapshot,
      dark: {
        ...snapshot.dark,
        variables: { ...snapshot.dark.variables, '--font-ui': 'url(https://invalid.example/font)' },
      },
    },
  ])('rejects incomplete or unsafe snapshots: %j', value => {
    expect(normalizeAppearanceThemeSnapshot(value)).toBeNull()
  })
})

describe('DesktopAppearanceController', () => {
  test('updates workbench windows for palette and system mode changes', () => {
    const createWindow = () => ({
      isDestroyed: vi.fn(() => false),
      setBackgroundColor: vi.fn(),
    })
    const main = createWindow()
    const detached = createWindow()
    const closed = createWindow()
    closed.isDestroyed.mockReturnValue(true)
    const nativeTheme = {
      themeSource: 'system' as 'system' | 'light' | 'dark',
      shouldUseDarkColors: true,
    }
    const controller = new DesktopAppearanceController({
      nativeTheme,
      windows: () => [main, detached, closed, null],
    })

    controller.update({ appearanceMode: 'system', appearanceThemeSnapshot: snapshot })

    for (const window of [main, detached]) {
      expect(window.setBackgroundColor).toHaveBeenCalledWith('#1a1b26')
    }
    expect(closed.setBackgroundColor).not.toHaveBeenCalled()

    nativeTheme.shouldUseDarkColors = false
    controller.update()
    expect(main.setBackgroundColor).toHaveBeenLastCalledWith('#ffffff')

    controller.update({ appearanceMode: 'dark', appearanceThemeSnapshot: snapshot })
    expect(nativeTheme.themeSource).toBe('dark')
    expect(main.setBackgroundColor).toHaveBeenLastCalledWith('#1a1b26')
  })
})
