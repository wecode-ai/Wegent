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
  'Wework',
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
  test('contains Wework and every reference theme with all 46 supported variants', () => {
    expect(UI_THEME_CATALOGUE.map(theme => theme.label)).toEqual(expectedNames)
    expect(new Set(UI_THEME_CATALOGUE.map(theme => theme.id)).size).toBe(30)
    expect(UI_THEME_CATALOGUE.filter(theme => theme.variants.light)).toHaveLength(17)
    expect(UI_THEME_CATALOGUE.filter(theme => theme.variants.dark)).toHaveLength(29)
    expect(
      UI_THEME_CATALOGUE.filter(theme => theme.variants.light && theme.variants.dark)
    ).toHaveLength(16)
  })

  test.each(['light', 'dark'] as const)('defaults to the original Wework %s palette', mode => {
    const theme = getUiTheme('wework', mode).variant
    expect(defaultAppearance[`${mode}ThemeId`]).toBe('wework')
    expect(theme.palette).toEqual(defaultThemeAppearance[mode])
    expect(theme.accentColor).toBe('#2563eb')
    const variables = resolveAppearanceThemeVariables(defaultAppearance, mode)
    expect(variables['--color-bg-base']).toBe(mode === 'light' ? '255 255 255' : '24 24 24')
    expect(variables['--color-bg-surface']).toBe(mode === 'light' ? '247 247 248' : '33 33 33')
    expect(variables['--color-sidebar']).toBe(
      mode === 'light' ? '246 246 246 / 0.88' : '33 33 33 / 0.92'
    )
    expect(variables['--color-border']).toBe(mode === 'light' ? '224 224 224' : '43 43 43')
    expect(variables['--color-primary']).toBe('37 99 235')
    expect(variables['--color-primary-contrast']).toBe('255 255 255')
  })

  test.each(['light', 'dark'] as const)(
    'preserves the original xterm ANSI palette in the Wework %s theme',
    mode => {
      const variables = resolveAppearanceThemeVariables(defaultAppearance, mode)
      const expected = [
        '46 52 54',
        '204 0 0',
        '78 154 6',
        '196 160 0',
        '52 101 164',
        '117 80 123',
        '6 152 154',
        '211 215 207',
        '85 87 83',
        '239 41 41',
        '138 226 52',
        '252 233 79',
        '114 159 207',
        '173 127 168',
        '52 226 226',
        '238 238 236',
      ]

      expect(TERMINAL_COLOR_NAMES.map(name => variables[`--color-terminal-${name}`])).toEqual(
        expected
      )
    }
  )

  test.each(['absolutely', 'codex', 'linear', 'matrix'])(
    'does not derive %s ANSI colors from unrelated syntax tokens',
    id => {
      const theme = getUiTheme(id, 'dark').variant
      expect(theme.terminal['bright-blue']).toBe('114 159 207')
      expect(theme.terminal['bright-cyan']).toBe('52 226 226')
      expect(theme.terminal['bright-green']).toBe('138 226 52')
    }
  )

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
    expect(signatures.size).toBe(46)
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
    expect(getUiTheme('proof', 'dark').id).toBe('wework')
    expect(getUiTheme('tokyo-night', 'light').id).toBe('wework')
    expect(getUiTheme('removed-theme', 'dark').id).toBe('wework')
  })

  test('preserves configured sidebar opacity until translucency is disabled', () => {
    const appearance = mergeAppearance({
      ...defaultAppearance,
      themeOverrides: { light: { palette: { sidebar: '4 5 6 / 0.8' } } },
    })
    expect(resolveAppearanceThemeVariables(appearance, 'light')['--color-sidebar']).toBe(
      '4 5 6 / 0.8'
    )
    expect(
      resolveAppearanceThemeVariables({ ...appearance, sidebarTranslucent: false }, 'light')[
        '--color-sidebar'
      ]
    ).toBe('4 5 6')
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
