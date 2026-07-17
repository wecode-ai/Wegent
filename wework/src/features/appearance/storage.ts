import { defaultAppearance } from './presets'
import type { AppearanceConfig, AppearanceMode, AppearanceUpdate, ThemePalette } from './types'
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

function mergePalette(base: ThemePalette, update: unknown): ThemePalette {
  if (!update || typeof update !== 'object') return base
  const next = { ...base, ...(update as Partial<ThemePalette>) }

  if (!next.mobileDrawer || next.mobileDrawer.includes('/')) {
    next.mobileDrawer = base.mobileDrawer
  }

  return next
}

export function mergeAppearance(update: AppearanceUpdate): AppearanceConfig {
  const nextMode: AppearanceMode =
    update.mode && APPEARANCE_MODES.has(update.mode) ? update.mode : defaultAppearance.mode
  const accentColor = isHexColor(update.accentColor)
    ? update.accentColor
    : defaultAppearance.accentColor

  return {
    ...defaultAppearance,
    ...update,
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
    backgroundImagePath:
      typeof update.backgroundImagePath === 'string' && update.backgroundImagePath.trim()
        ? update.backgroundImagePath
        : null,
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
