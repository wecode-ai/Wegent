import fs from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { afterEach, expect, test } from 'vitest'
import tailwindConfig from '../../../tailwind.config.js'
import { applyAppearance, resolveAppearanceThemeVariables } from './applyAppearance'
import { defaultAppearance } from './presets'
import { mergeAppearance } from './storage'
import {
  UI_THEME_CATALOGUE,
  getUiTheme,
  resolveUiThemeVariables,
} from '@wegent/collaboration/theme'
import { codeThemeCSS } from '../../../../packages/collaboration/src/markdown/codeTheme'

const readSource = (file: string) =>
  fs.readFileSync(path.resolve(import.meta.dirname, '../..', file), 'utf8')

afterEach(() => {
  document.documentElement.removeAttribute('data-appearance-theme')
  document.documentElement.removeAttribute('style')
  document.documentElement.classList.remove('dark')
})

test.each(['light', 'dark'] as const)('restores the original Wework %s tokens', mode => {
  const variables = resolveAppearanceThemeVariables(defaultAppearance, mode)
  for (const token of ['focus', 'focus-ring', 'link']) {
    expect(variables[`--color-${token}`]).toBe('51 156 255')
  }
  expect(variables['--color-scrollbar-thumb']).toBe(
    mode === 'light' ? '0 0 0 / 0.08' : '255 255 255 / 0.36'
  )
  expect(variables['--color-scrollbar-thumb-hover']).toBe(
    mode === 'light' ? '0 0 0 / 0.12' : '255 255 255 / 0.5'
  )
})

test('preserves explicit Wework overrides and all non-color preferences', () => {
  const appearance = mergeAppearance({
    ...defaultAppearance,
    themeOverrides: {
      light: { accentColor: '#123456', palette: { bgBase: '1 2 3', sidebar: '4 5 6 / 0.8' } },
    },
    uiFont: 'Custom UI, sans-serif',
    codeFont: 'Custom Code, monospace',
    uiFontSize: 16,
    codeFontSize: 18,
    backgroundImagePath: 'C:\\Pictures\\wallpaper.png',
  })
  const before = structuredClone(appearance)
  applyAppearance(appearance, 'light')
  expect(appearance).toEqual(before)
  const variables = resolveAppearanceThemeVariables(appearance, 'light')
  expect(variables['--color-primary']).toBe('18 52 86')
  expect(variables['--color-focus']).toBe('18 52 86')
  expect(variables['--color-bg-base']).toBe('1 2 3')
  expect(variables['--color-sidebar']).toBe('4 5 6 / 0.8')
  expect(variables['--font-ui']).toBe('Custom UI, sans-serif')
  expect(variables['--font-code']).toBe('Custom Code, monospace')
  expect(variables['--font-size-ui']).toBe('16px')
  expect(variables['--font-size-code']).toBe('18px')
})

test('switches named themes back to Wework without stale named tokens', () => {
  const appearance = mergeAppearance({ ...defaultAppearance, darkThemeId: 'tokyo-night' })
  applyAppearance(appearance, 'dark')
  expect(document.documentElement.style.getPropertyValue('--color-focus')).toBe('122 162 247')
  applyAppearance(defaultAppearance, 'dark')
  expect(document.documentElement.style.getPropertyValue('--color-focus')).toBe('51 156 255')
  expect(document.documentElement.style.getPropertyValue('--color-scrollbar-thumb')).toBe(
    '255 255 255 / 0.36'
  )
})

test('leaves every named palette and appearance token unchanged', () => {
  for (const definition of UI_THEME_CATALOGUE) {
    if (definition.id === 'wework') continue
    for (const mode of ['light', 'dark'] as const) {
      if (!definition.variants[mode]) continue
      const appearance = mergeAppearance({
        ...defaultAppearance,
        [`${mode}ThemeId`]: definition.id,
      })
      const variables = resolveAppearanceThemeVariables(appearance, mode)
      const original = resolveUiThemeVariables(mode, definition.id)
      for (const [property, value] of Object.entries(original)) {
        expect(variables[property as `--${string}`], `${definition.id}/${mode}/${property}`).toBe(
          value
        )
      }
      expect(variables['--color-focus']).toBe(
        getUiTheme(definition.id, mode).variant.palette.primary
      )
    }
  }
})

test('limits renderer adapters to named themes and keeps original Markdown palettes for Wework', () => {
  const adapters = postcss.parse(readSource('styles/content-themes.css'))
  adapters.walkRules(rule => {
    for (const selector of rule.selectors) {
      expect(selector).toContain(
        "html[data-appearance-theme]:not(:where([data-appearance-theme='wework']))"
      )
    }
  })
  const syntax = postcss.parse(codeThemeCSS)
  const paletteRule = syntax.nodes.find(
    node => node.type === 'rule' && node.selector.startsWith('html')
  )
  expect(paletteRule?.type === 'rule' && paletteRule.selector).toContain(
    ":not(:where([data-appearance-theme='wework']))"
  )
  expect(codeThemeCSS).toContain('--hls-keyword: #d32a61')
  expect(codeThemeCSS).toContain('--hls-keyword: #ff678d')
})

test('restores original plugin recipes without overriding provided-logo dark rules', () => {
  const defaults = postcss.parse(readSource('styles/wework-theme.css'))
  const values: Record<string, string> = {}
  defaults.walkRules(rule => {
    expect(rule.selector).toBe("html[data-appearance-theme='wework']")
    rule.walkDecls(declaration => {
      values[declaration.prop] = declaration.value
    })
  })
  expect(values['--wework-plugin-logo-bg']).toBe('rgb(245 245 247)')
  expect(values['--wework-source-personal-text']).toBe('rgb(114 89 163)')
  expect(values['--wework-lightbox-close-bg']).toBe('rgb(255 255 255 / 0.16)')
  expect(values).not.toHaveProperty('--color-primary')
  expect(values).not.toHaveProperty('--color-bg-base')
  expect(values).not.toHaveProperty('--font-ui')
  const styles = postcss.parse(readSource('styles/globals.css'))
  const logoRules: string[] = []
  styles.walkDecls(declaration => {
    if (declaration.value.includes('--wework-plugin-logo-bg')) {
      const parent = declaration.parent
      expect(parent?.type).toBe('rule')
      if (parent?.type === 'rule') logoRules.push(parent.selector)
    }
  })
  expect(logoRules).toEqual([
    '.plugin-management-logo',
    '.plugin-market-card-logo,\n.plugin-installed-strip-logo',
    '.plugin-detail-header-logo,\n.plugin-detail-prompt-logo',
    '.plugin-market-reveal-logo',
  ])
})

test('compiles original component recipes only for Wework, including dark and hover states', async () => {
  const sources = [
    'components/chat/FileChangesReviewPanel.tsx',
    'components/common/ChangeRequestStatusIcon.tsx',
    'components/settings/settings-ui.tsx',
    'components/plugins/PluginManagementRows.tsx',
    'features/workspace-tabs/WorkspaceTabStrip.tsx',
  ].map(readSource)
  const root = postcss.parse(
    (
      await postcss([
        tailwindcss({
          ...tailwindConfig,
          content: sources.map(raw => ({ raw, extension: 'tsx' })),
        }),
      ]).process('@tailwind utilities;', { from: undefined })
    ).css
  )
  const element = document.createElement('span')
  document.body.append(element)
  try {
    for (const className of [
      'wework:text-green-600',
      'wework:text-red-600',
      'wework:text-violet-500',
      'wework:bg-blue-500',
      'wework:bg-emerald-600',
      'wework:dark:bg-white/[0.09]',
      'wework:hover:bg-black/[0.045]',
    ]) {
      element.className = className
      document.documentElement.classList.add('dark')
      const selectors: string[] = []
      root.walkRules(rule => {
        if (rule.selector.includes(className.replace(/[^\w-]/g, character => `\\${character}`))) {
          selectors.push(rule.selector)
        }
      })
      expect(selectors, className).not.toHaveLength(0)
      document.documentElement.dataset.appearanceTheme = 'wework'
      const stateSelectors = selectors.map(selector => selector.replace(/(?<!\\):hover/g, ''))
      expect(
        stateSelectors.some(selector => element.matches(selector)),
        className
      ).toBe(true)
      for (const themeId of ['tokyo-night', 'catppuccin', 'github']) {
        document.documentElement.dataset.appearanceTheme = themeId
        expect(
          stateSelectors.some(selector => element.matches(selector)),
          themeId
        ).toBe(false)
      }
    }
  } finally {
    element.remove()
  }
})
