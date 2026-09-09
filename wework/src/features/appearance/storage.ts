import { defaultAppearance } from './presets'
import type {
  AppearanceConfig,
  AppearanceMode,
  AppearanceUpdate,
  ThemePalette,
  WorkbenchBackgroundConfig,
} from './types'
import { clampContrast, isHexColor } from './color'
import { normalizeCodeFontSize, normalizeUiFontSize } from './typography'

const STORAGE_KEY = 'wework.appearance'
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

function mergePalette(
  base: ThemePalette,
  update: unknown,
  legacyPalette?: ThemePalette
): ThemePalette {
  if (!update || typeof update !== 'object') return base
  const next = { ...base, ...(update as Partial<ThemePalette>) }

  for (const key of Object.keys(base) as Array<keyof ThemePalette>) {
    if (legacyPalette && next[key] === legacyPalette[key]) {
      next[key] = base[key]
    }
  }

  if (LEGACY_DEFAULT_SIDEBARS.has(next.sidebar)) {
    next.sidebar = base.sidebar
  }

  if (!next.mobileDrawer || next.mobileDrawer.includes('/')) {
    next.mobileDrawer = base.mobileDrawer
  }

  return next
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
  const accentColor = isHexColor(update.accentColor)
    ? update.accentColor
    : defaultAppearance.accentColor

  return {
    ...defaultAppearance,
    ...normalizedUpdate,
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
    light: mergePalette(defaultAppearance.light, update.light),
    dark: mergePalette(defaultAppearance.dark, update.dark, LEGACY_DARK_PALETTE),
  }
}

export function readStoredAppearance(): AppearanceConfig {
  if (typeof window === 'undefined') return defaultAppearance

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultAppearance
    return mergeAppearance(JSON.parse(raw) as AppearanceUpdate)
  } catch {
    return defaultAppearance
  }
}

export function writeStoredAppearance(appearance: AppearanceConfig) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance))
  } catch {
    // Ignore storage failures, for example private browsing restrictions.
  }
}

export function clearStoredAppearance() {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore storage failures.
  }
}
