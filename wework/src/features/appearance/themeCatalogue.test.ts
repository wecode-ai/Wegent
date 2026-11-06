import { describe, expect, test } from 'vitest'
import {
  UI_THEME_CATALOGUE,
  SYNTAX_COLOR_NAMES,
  TERMINAL_COLOR_NAMES,
  defaultThemeAppearance,
  contrastForegroundColor,
  getUiTheme,
  resolveThemeVariables,
} from '@wegent/collaboration/theme'
import { resolveAppearanceThemeVariables } from './applyAppearance'
import { defaultAppearance } from './presets'
import { mergeAppearance } from './storage'

const expectedNames = [
  'Absolutely',
  'Ayu',
  'Catppuccin',
  'ChatGPT',
  'Dracula',
  'Everforest',
  'GitHub',
  'Gruvbox',
  'Linear',
  'Lobster',
  'Material',
  'Matrix',
  'Monokai',
  'Night Owl',
  'Nord',
  'Notion',
  'OG',
  'Oscurange',
  'One',
  'Proof',
  'Raycast',
  'Rose Pine',
  'Sentry',
  'Solarized',
  'Temple',
  'Tokyo Night',
  'Vercel',
  'VS Code Plus',
  'Xcode',
]

describe('desktop theme catalogue', () => {
  test('contains every reference theme and all 44 supported variants', () => {
    expect(UI_THEME_CATALOGUE.map(theme => theme.label)).toEqual(expectedNames)
    expect(new Set(UI_THEME_CATALOGUE.map(theme => theme.id)).size).toBe(29)
    expect(UI_THEME_CATALOGUE.filter(theme => theme.variants.light)).toHaveLength(16)
    expect(UI_THEME_CATALOGUE.filter(theme => theme.variants.dark)).toHaveLength(28)
    expect(
      UI_THEME_CATALOGUE.filter(theme => theme.variants.light && theme.variants.dark)
    ).toHaveLength(15)
  })

  test('provides distinct palettes and complete code and terminal colors', () => {
    const signatures = new Set<string>()
    for (const theme of UI_THEME_CATALOGUE) {
      for (const mode of ['light', 'dark'] as const) {
        const variant = theme.variants[mode]
        if (!variant) continue
        signatures.add(JSON.stringify([variant.palette, variant.syntax]))
        const appearance = mergeAppearance({
          ...defaultAppearance,
          [`${mode}ThemeId`]: theme.id,
          mode,
        })
        const variables = resolveAppearanceThemeVariables(appearance, mode)
        for (const name of SYNTAX_COLOR_NAMES)
          expect(variables[`--color-syntax-${name}`]).toMatch(/^\d+ \d+ \d+$/)
        for (const name of TERMINAL_COLOR_NAMES)
          expect(variables[`--color-terminal-${name}`]).toMatch(/^\d+ \d+ \d+$/)
        expect(variables['--color-titlebar']).toBe(variant.palette.bgSurface)
        expect(variables['--color-diff-added']).toBe(variant.added)
        expect(variables['--color-diff-removed']).toBe(variant.removed)
        expect(variables['--color-success-contrast']).toBe(contrastForegroundColor(variant.added))
        expect(variables['--color-destructive-contrast']).toBe(
          contrastForegroundColor(variant.removed)
        )
        expect(Object.values(variables).join(' ')).not.toContain('NaN')
      }
    }
    expect(signatures.size).toBe(44)
  })

  test('uses the verified Tokyo Night colors throughout the workbench', () => {
    const appearance = mergeAppearance({
      ...defaultAppearance,
      darkThemeId: 'tokyo-night',
      mode: 'dark',
    })
    const variables = resolveAppearanceThemeVariables(appearance, 'dark')
    expect(variables['--color-bg-base']).toBe('26 27 38')
    expect(variables['--color-text-primary']).toBe('169 177 214')
    expect(variables['--color-primary']).toBe('122 162 247')
    expect(variables['--color-syntax-keyword']).toBe('187 154 247')
    expect(variables['--color-terminal-red']).toBe('247 118 142')
  })

  test('keeps the default shared Web appearance independent of desktop themes', () => {
    const variables = resolveThemeVariables('dark')
    expect(variables['--color-bg-base']).toBe(defaultThemeAppearance.dark.bgBase)
    expect(variables['--color-primary']).toBe('37 99 235')
    expect(variables).not.toHaveProperty('--color-terminal-red')
    expect(getUiTheme('proof', 'dark').id).toBe('codex')
    expect(getUiTheme('tokyo-night', 'light').id).toBe('codex')
  })

  test('preserves explicit palette edits, custom accents and opaque sidebars', () => {
    const appearance = mergeAppearance({
      ...defaultAppearance,
      mode: 'dark',
      darkThemeId: 'tokyo-night',
      sidebarTranslucent: false,
      themeOverrides: {
        dark: {
          accentColor: '#123456',
          palette: { bgBase: '1 2 3', bgSurface: '4 5 6', sidebar: '7 8 9' },
        },
      },
    })
    const variables = resolveAppearanceThemeVariables(appearance, 'dark')
    expect(variables['--color-bg-base']).toBe('1 2 3')
    expect(variables['--color-bg-surface']).toBe('4 5 6')
    expect(variables['--color-titlebar']).toBe('4 5 6')
    expect(variables['--color-sidebar']).toBe('7 8 9')
    expect(variables['--color-primary']).toBe('18 52 86')
    expect(variables['--color-link']).toBe('18 52 86')
    expect(variables['--color-syntax-keyword']).toBe('187 154 247')
  })

  test('recomputes contrast for a custom accent independently of status fills', () => {
    const appearance = mergeAppearance({
      ...defaultAppearance,
      mode: 'dark',
      darkThemeId: 'matrix',
      themeOverrides: { dark: { accentColor: '#ffffff' } },
    })
    const variables = resolveAppearanceThemeVariables(appearance, 'dark')
    expect(variables['--color-primary-contrast']).toBe('0 0 0')
    expect(variables['--color-destructive-contrast']).toBe(
      contrastForegroundColor(variables['--color-destructive'])
    )
    expect(contrastForegroundColor('0 0 0')).toBe('255 255 255')
    expect(contrastForegroundColor('255 255 255')).toBe('0 0 0')
  })
})
