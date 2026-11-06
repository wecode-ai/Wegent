import { describe, expect, test, vi } from 'vitest'
import { normalizeAppearanceThemeSnapshot } from './appearance-theme-contract.js'
import {
  APPEARANCE_THEME_CHANNEL,
  DesktopAppearanceController,
  resolveHostAppearance,
} from './appearance-theme.js'

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
      themeId: 'codex',
      backgroundColor: '#111111',
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
  test('updates all native windows and startup documents while preserving transparency', () => {
    const createWindow = () => ({
      isDestroyed: vi.fn(() => false),
      setBackgroundColor: vi.fn(),
      webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
    })
    const main = createWindow()
    const detached = createWindow()
    const splash = createWindow()
    const transparent = createWindow()
    const closed = createWindow()
    closed.isDestroyed.mockReturnValue(true)
    const nativeTheme = {
      themeSource: 'system' as 'system' | 'light' | 'dark',
      shouldUseDarkColors: true,
    }
    const controller = new DesktopAppearanceController({
      nativeTheme,
      windows: () => [
        { window: main },
        { window: detached },
        { window: splash },
        { window: transparent, transparent: true },
        { window: closed },
      ],
    })

    controller.update({ appearanceMode: 'system', appearanceThemeSnapshot: snapshot })

    for (const window of [main, detached, splash]) {
      expect(window.setBackgroundColor).toHaveBeenCalledWith('#1a1b26')
      expect(window.webContents.send).toHaveBeenCalledWith(
        APPEARANCE_THEME_CHANNEL,
        expect.objectContaining({ mode: 'dark', themeId: 'tokyo-night' })
      )
    }
    expect(transparent.setBackgroundColor).not.toHaveBeenCalled()
    expect(transparent.webContents.send).toHaveBeenCalledOnce()
    expect(closed.webContents.send).not.toHaveBeenCalled()

    nativeTheme.shouldUseDarkColors = false
    controller.update()
    expect(main.setBackgroundColor).toHaveBeenLastCalledWith('#ffffff')

    controller.update({ appearanceMode: 'dark', appearanceThemeSnapshot: snapshot })
    expect(nativeTheme.themeSource).toBe('dark')
    expect(main.setBackgroundColor).toHaveBeenLastCalledWith('#1a1b26')
  })
})
