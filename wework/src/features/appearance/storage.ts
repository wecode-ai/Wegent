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

function mergePalette(base: ThemePalette, update: unknown): ThemePalette {
  if (!update || typeof update !== 'object') return base
  const next = { ...base, ...(update as Partial<ThemePalette>) }

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
    dark: mergePalette(defaultAppearance.dark, update.dark),
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
