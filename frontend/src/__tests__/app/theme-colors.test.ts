// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs'
import path from 'node:path'

const readGlobalCss = () => fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8')

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
})
