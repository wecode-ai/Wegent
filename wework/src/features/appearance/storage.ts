import { defaultAppearance } from './presets'
import { defaultThemeAppearance, getUiTheme } from '@wegent/collaboration/theme'
import type {
  AppearanceConfig,
  AppearanceMode,
  AppearanceUpdate,
  AppearanceThemeOverrides,
  ThemePalette,
  WorkbenchBackgroundConfig,
} from './types'
import { clampContrast, isHexColor } from './color'
import { normalizeCodeFontSize, normalizeUiFontSize } from './typography'

export const APPEARANCE_STORAGE_KEY = 'wework.appearance'
const APPEARANCE_MODES = new Set(['light', 'dark', 'system'])
const LEGACY_DARK_PALETTE: ThemePalette = {
  bgBase: '17 19 22',
  bgSurface: '28 31 36',
  bgMuted: '38 42 48',
  bgHover: '96 165 250 / 0.12',
  sidebar: '40 40 40 / 0.92',
  sidebarActive: '52 58 66',
  sidebarHover: '255 255 255 / 0.08',
  sidebarTextPrimary: '232 238 246',
  sidebarTextSecondary: '181 191 205',
  sidebarTextMuted: '126 138 153',
  mobileDrawer: '24 39 58',
  border: '55 61 70',
  textPrimary: '241 245 249',
  textSecondary: '203 213 225',
  textMuted: '148 163 184',
  primary: '96 165 250',
  primaryContrast: '11 18 20',
  popover: '28 31 36',
  codeBg: '15 23 42',
}
const LEGACY_DEFAULT_SIDEBARS = new Set(['229 229 231 / 0.72', '31 35 41 / 0.82'])

function normalizeBackgroundVisibility(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return defaultAppearance.backgroundVisibility
  }
  return Math.round(Math.min(100, Math.max(0, value)))
}

function normalizeBackgroundBlur(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return defaultAppearance.backgroundBlur
  }
  return Math.round(Math.min(20, Math.max(0, value)))
}

function mergeBackground(
  base: WorkbenchBackgroundConfig,
  update: unknown
): WorkbenchBackgroundConfig {
  const value =
    update && typeof update === 'object' ? (update as Partial<WorkbenchBackgroundConfig>) : {}
  return {
    imagePath:
      typeof value.imagePath === 'string' && value.imagePath.trim() ? value.imagePath : null,
    visibility: normalizeBackgroundVisibility(value.visibility ?? base.visibility),
    blur: normalizeBackgroundBlur(value.blur ?? base.blur),
    inMain: typeof value.inMain === 'boolean' ? value.inMain : base.inMain,
    inSidebar: typeof value.inSidebar === 'boolean' ? value.inSidebar : base.inSidebar,
    inTopBar: typeof value.inTopBar === 'boolean' ? value.inTopBar : base.inTopBar,
  }
}

function normalizePaletteOverrides(
  base: ThemePalette,
  update: unknown,
  legacyPalette?: ThemePalette
): Partial<ThemePalette> {
  if (!update || typeof update !== 'object') return {}
  const candidate = update as Partial<ThemePalette>
  const next: Partial<ThemePalette> = {}
  for (const key of Object.keys(base) as Array<keyof ThemePalette>) {
    const value = candidate[key]
    if (
      typeof value !== 'string' ||
      !/^\d{1,3} \d{1,3} \d{1,3}(?: \/ (?:0(?:\.\d+)?|1))?$/.test(value)
    )
      continue
    if (value === base[key] || value === legacyPalette?.[key]) continue
    if (key === 'sidebar' && LEGACY_DEFAULT_SIDEBARS.has(value)) continue
    if ((key === 'mobileDrawer' || key === 'bgBase') && value.includes('/')) continue
    const channels = value.split('/')[0].trim().split(' ').map(Number)
    if (channels.some(channel => channel > 255)) continue
    next[key] = value
  }
  return next
}

function normalizeThemeOverrides(
  update: AppearanceUpdate,
  mode: 'light' | 'dark'
): AppearanceThemeOverrides {
  const legacy = update.schemaVersion !== 2
  const source = legacy ? undefined : update.themeOverrides?.[mode]
  const accentColor = source?.accentColor ?? (legacy ? update.accentColor : undefined)
  const palette = normalizePaletteOverrides(
    legacy
      ? defaultThemeAppearance[mode]
      : getUiTheme(
          mode === 'dark'
            ? (update.darkThemeId ?? defaultAppearance.darkThemeId)
            : (update.lightThemeId ?? defaultAppearance.lightThemeId),
          mode
        ).variant.palette,
    legacy ? update[mode] : source?.palette,
    legacy && mode === 'dark' ? LEGACY_DARK_PALETTE : undefined
  )
  return {
    ...(isHexColor(accentColor) && (!legacy || accentColor !== defaultThemeAppearance.accentColor)
      ? { accentColor }
      : {}),
    ...(Object.keys(palette).length ? { palette } : {}),
  }
}

export function mergeAppearance(update: AppearanceUpdate): AppearanceConfig {
  const legacyUpdate = update as AppearanceUpdate & {
    lightBackgroundImagePath?: unknown
    darkBackgroundImagePath?: unknown
  }
  const normalizedUpdate = { ...legacyUpdate }
  delete normalizedUpdate.lightBackgroundImagePath
  delete normalizedUpdate.darkBackgroundImagePath
  const normalizedBackgroundImagePath =
    typeof update.backgroundImagePath === 'string' && update.backgroundImagePath.trim()
      ? update.backgroundImagePath
      : null
  const nextMode: AppearanceMode =
    update.mode && APPEARANCE_MODES.has(update.mode) ? update.mode : defaultAppearance.mode
  const lightTheme = getUiTheme(update.lightThemeId ?? defaultAppearance.lightThemeId, 'light')
  const darkTheme = getUiTheme(update.darkThemeId ?? defaultAppearance.darkThemeId, 'dark')
  const themeOverrides = {
    light: normalizeThemeOverrides(update, 'light'),
    dark: normalizeThemeOverrides(update, 'dark'),
  }
  const resolvedMode =
    nextMode === 'system'
      ? typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : nextMode
  const activeTheme = resolvedMode === 'dark' ? darkTheme : lightTheme
  const accentColor = themeOverrides[resolvedMode].accentColor ?? activeTheme.variant.accentColor

  return {
    ...defaultAppearance,
    ...normalizedUpdate,
    schemaVersion: 2,
    lightThemeId: lightTheme.id,
    darkThemeId: darkTheme.id,
    themeOverrides,
    mode: nextMode,
    accentColor,
    uiFont:
      typeof update.uiFont === 'string' && update.uiFont.trim()
        ? update.uiFont
        : defaultAppearance.uiFont,
    codeFont:
      typeof update.codeFont === 'string' && update.codeFont.trim()
        ? update.codeFont
        : defaultAppearance.codeFont,
    uiFontSize: normalizeUiFontSize(update.uiFontSize),
    codeFontSize: normalizeCodeFontSize(update.codeFontSize),
    sidebarTranslucent:
      typeof update.sidebarTranslucent === 'boolean'
        ? update.sidebarTranslucent
        : defaultAppearance.sidebarTranslucent,
    contrast: clampContrast(update.contrast),
    backgroundImagePath: normalizedBackgroundImagePath,
    separateBackgroundsByTheme:
      typeof update.separateBackgroundsByTheme === 'boolean'
        ? update.separateBackgroundsByTheme
        : defaultAppearance.separateBackgroundsByTheme,
    themeBackgroundsInitialized:
      typeof update.themeBackgroundsInitialized === 'boolean'
        ? update.themeBackgroundsInitialized
        : defaultAppearance.themeBackgroundsInitialized,
    backgroundVisibility: normalizeBackgroundVisibility(update.backgroundVisibility),
    backgroundBlur: normalizeBackgroundBlur(update.backgroundBlur),
    backgroundInMain:
      typeof update.backgroundInMain === 'boolean'
        ? update.backgroundInMain
        : defaultAppearance.backgroundInMain,
    backgroundInSidebar:
      typeof update.backgroundInSidebar === 'boolean'
        ? update.backgroundInSidebar
        : defaultAppearance.backgroundInSidebar,
    backgroundInTopBar:
      typeof update.backgroundInTopBar === 'boolean'
        ? update.backgroundInTopBar
        : defaultAppearance.backgroundInTopBar,
    lightBackground: mergeBackground(defaultAppearance.lightBackground, {
      ...update.lightBackground,
      imagePath: update.lightBackground?.imagePath ?? legacyUpdate.lightBackgroundImagePath ?? null,
    }),
    darkBackground: mergeBackground(defaultAppearance.darkBackground, {
      ...update.darkBackground,
      imagePath: update.darkBackground?.imagePath ?? legacyUpdate.darkBackgroundImagePath ?? null,
    }),
    light: { ...lightTheme.variant.palette, ...themeOverrides.light.palette },
    dark: { ...darkTheme.variant.palette, ...themeOverrides.dark.palette },
  }
}

export function readStoredAppearance(): AppearanceConfig {
  if (typeof window === 'undefined') return defaultAppearance

  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY)
    if (!raw) return defaultAppearance
    return mergeAppearance(JSON.parse(raw) as AppearanceUpdate)
  } catch {
    return defaultAppearance
  }
}

export function writeStoredAppearance(appearance: AppearanceConfig) {
  if (typeof window === 'undefined') return

  try {
    const serialized = JSON.stringify({
      ...appearance,
      light: undefined,
      dark: undefined,
      accentColor: undefined,
    })
    if (window.localStorage.getItem(APPEARANCE_STORAGE_KEY) !== serialized) {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, serialized)
    }
  } catch {
    // Ignore storage failures, for example private browsing restrictions.
  }
}

export function clearStoredAppearance() {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.removeItem(APPEARANCE_STORAGE_KEY)
  } catch {
    // Ignore storage failures.
  }
}
