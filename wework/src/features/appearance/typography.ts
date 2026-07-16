export const DEFAULT_UI_FONT_SIZE = 14
export const MIN_UI_FONT_SIZE = 11
export const MAX_UI_FONT_SIZE = 16

export const DEFAULT_CODE_FONT_SIZE = 12
export const MIN_CODE_FONT_SIZE = 8
export const MAX_CODE_FONT_SIZE = 24

const CODEX_UI_TYPE_SCALE = {
  '--text-xs': 12,
  '--text-sm': 13,
  '--text-base': 14,
  '--text-lg': 16,
  '--text-xl': 28,
  '--text-2xl': 36,
  '--text-3xl': 48,
  '--text-4xl': 72,
  '--text-heading-sm': 18,
  '--text-heading-md': 20,
  '--text-heading-lg': 24,
} as const

export type TypographyVariable = keyof typeof CODEX_UI_TYPE_SCALE

export function normalizeFontSize(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

export function normalizeUiFontSize(value: unknown): number {
  return normalizeFontSize(value, DEFAULT_UI_FONT_SIZE, MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE)
}

export function normalizeCodeFontSize(value: unknown): number {
  return normalizeFontSize(value, DEFAULT_CODE_FONT_SIZE, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE)
}

export function resolveUiTypographyVariables(
  uiFontSize: number
): Record<TypographyVariable, string> {
  const normalizedSize = normalizeUiFontSize(uiFontSize)
  const scale = normalizedSize / DEFAULT_UI_FONT_SIZE

  return Object.fromEntries(
    Object.entries(CODEX_UI_TYPE_SCALE).map(([variable, baseSize]) => [
      variable,
      `${Math.round(baseSize * scale)}px`,
    ])
  ) as Record<TypographyVariable, string>
}
