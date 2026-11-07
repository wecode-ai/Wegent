export type AppearanceThemeMode = 'light' | 'dark'

export interface AppearanceThemeVariantSnapshot {
  themeId: string
  variables: Record<string, string>
}

/** Native workbench windows resolve the selected palette for either system mode. */
export interface AppearanceThemeSnapshot {
  light: AppearanceThemeVariantSnapshot
  dark: AppearanceThemeVariantSnapshot
}

function normalizeVariant(value: unknown): AppearanceThemeVariantSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.themeId !== 'string' || !/^[a-z0-9-]+$/.test(record.themeId)) return null
  if (!record.variables || typeof record.variables !== 'object') return null
  const entries = Object.entries(record.variables)
  if (entries.length === 0 || entries.length > 512) return null
  const variables: Record<string, string> = {}
  for (const [name, variable] of entries) {
    if (
      !/^--[a-z0-9-]+$/.test(name) ||
      typeof variable !== 'string' ||
      variable.length > 1024 ||
      /[;{}<>]|url\s*\(|expression\s*\(/i.test(variable)
    ) {
      return null
    }
    variables[name] = variable
  }
  if (!nativeBackgroundColor(variables['--color-bg-base'])) return null
  return { themeId: record.themeId, variables }
}

export function normalizeAppearanceThemeSnapshot(value: unknown): AppearanceThemeSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const light = normalizeVariant(record.light)
  const dark = normalizeVariant(record.dark)
  return light && dark ? { light, dark } : null
}

export function nativeBackgroundColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const channels = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/.exec(value.trim())
  if (!channels) return null
  const rgb = channels.slice(1).map(Number)
  if (rgb.some(channel => channel > 255)) return null
  return `#${rgb.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}
