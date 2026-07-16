import { describe, expect, test } from 'vitest'
import {
  normalizeCodeFontSize,
  normalizeUiFontSize,
  resolveUiTypographyVariables,
} from './typography'

describe('appearance typography', () => {
  test('uses the Codex desktop defaults', () => {
    expect(resolveUiTypographyVariables(14)).toEqual({
      '--text-xs': '12px',
      '--text-sm': '13px',
      '--text-base': '14px',
      '--text-lg': '16px',
      '--text-xl': '28px',
      '--text-2xl': '36px',
      '--text-3xl': '48px',
      '--text-4xl': '72px',
      '--text-heading-sm': '18px',
      '--text-heading-md': '20px',
      '--text-heading-lg': '24px',
    })
  })

  test('scales and rounds the complete UI ramp like Codex', () => {
    expect(resolveUiTypographyVariables(16)).toMatchObject({
      '--text-xs': '14px',
      '--text-sm': '15px',
      '--text-base': '16px',
      '--text-lg': '18px',
      '--text-xl': '32px',
      '--text-heading-sm': '21px',
      '--text-heading-md': '23px',
      '--text-heading-lg': '27px',
    })
  })

  test('normalizes stored values to supported integer ranges', () => {
    expect(normalizeUiFontSize(8)).toBe(11)
    expect(normalizeUiFontSize(15.6)).toBe(16)
    expect(normalizeUiFontSize(20)).toBe(16)
    expect(normalizeUiFontSize('14')).toBe(14)
    expect(normalizeCodeFontSize(2)).toBe(8)
    expect(normalizeCodeFontSize(30)).toBe(24)
  })
})
