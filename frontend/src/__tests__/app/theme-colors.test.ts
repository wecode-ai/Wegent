// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs'
import path from 'node:path'
import resolveConfig from 'tailwindcss/resolveConfig'
import tailwindConfiguration from '../../../tailwind.config'

const readGlobalCss = () => fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8')
const readTailwindConfig = () =>
  fs.readFileSync(path.join(process.cwd(), 'tailwind.config.js'), 'utf8')

const getDarkThemeRule = () => {
  const css = readGlobalCss()
  const match = css.match(/\[data-theme='dark'\] \{([\s\S]*?)\n\}/)

  if (!match) {
    throw new Error('Dark theme CSS rule was not found')
  }

  return match[1]
}

const getCssVariable = (rule: string, variableName: string) => {
  const escapedName = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = rule.match(new RegExp(`${escapedName}:\\s*([^;]+);`))

  if (!match) {
    throw new Error(`${variableName} was not found in dark theme rule`)
  }

  return match[1].trim()
}

describe('theme color tokens', () => {
  it('uses a softer dark mode text hierarchy instead of near-white defaults', () => {
    const darkThemeRule = getDarkThemeRule()

    expect(getCssVariable(darkThemeRule, '--color-text-primary')).toBe('212 212 212')
    expect(getCssVariable(darkThemeRule, '--color-text-secondary')).toBe('176 176 176')
    expect(getCssVariable(darkThemeRule, '--color-text-muted')).toBe('136 136 136')
    expect(getCssVariable(darkThemeRule, '--color-popover-foreground')).toBe('212 212 212')
  })

  it('exposes the shared focus color to Tailwind collaboration components', () => {
    const darkThemeRule = getDarkThemeRule()

    expect(getCssVariable(darkThemeRule, '--color-focus')).toBe('118 119 218')
    expect(readGlobalCss()).toContain('--color-focus: 93 94 201;')
    expect(readTailwindConfig()).toContain("focus: withOpacity('--color-focus')")
  })

  it('exposes the shared collaboration heading scale', () => {
    const css = readGlobalCss()
    const tailwindConfig = readTailwindConfig()
    const preset = fs.readFileSync(
      path.join(process.cwd(), '../packages/collaboration/tailwind-preset.js'),
      'utf8'
    )

    expect(css).toContain('--text-heading-sm: 18px;')
    expect(css).toContain('--text-heading-md: 20px;')
    expect(css).toContain('--text-heading-lg: 24px;')
    expect(css).toContain('--font-weight-ui: 445;')
    expect(css).toContain('--text-sm: 13px;')
    expect(css).toContain('--text-base: 14px;')
    expect(css).toContain('font-family: var(--font-ui);')
    expect(css).toContain('font-weight: var(--font-weight-ui);')
    expect(preset).toContain('.heading-base')
    expect(preset).toContain('.heading-subsection')
    expect(tailwindConfig).toContain("sm: ['var(--text-sm)'")
    expect(tailwindConfig).toContain("base: ['var(--text-base)'")
    expect(tailwindConfig).toContain("'heading-sm': ['var(--text-heading-sm)'")
    expect(tailwindConfig).toContain("'heading-md': ['var(--text-heading-md)'")
    expect(tailwindConfig).toContain("'heading-lg': ['var(--text-heading-lg)'")
  })

  it('extends the font scale without removing default large heading sizes', () => {
    const config = resolveConfig(tailwindConfiguration)
    expect(config.theme.fontSize['5xl']).toEqual(['3rem', { lineHeight: '1' }])
    expect(config.theme.fontSize.base[0]).toBe('var(--text-base)')
  })
})
