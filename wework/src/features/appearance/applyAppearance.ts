import { hexToRgbTriplet } from './color'
import { darkPalette, lightPalette } from './presets'
import type { AppearanceConfig, ResolvedAppearanceMode, ThemePalette } from './types'

const PALETTE_VARIABLES: Record<keyof ThemePalette, string> = {
  bgBase: '--color-bg-base',
  bgSurface: '--color-bg-surface',
  bgMuted: '--color-muted',
  bgHover: '--color-bg-hover',
  sidebar: '--color-sidebar',
  sidebarActive: '--color-sidebar-active',
  sidebarHover: '--color-sidebar-hover',
  sidebarTextPrimary: '--color-sidebar-text-primary',
  sidebarTextSecondary: '--color-sidebar-text-secondary',
  sidebarTextMuted: '--color-sidebar-text-muted',
  mobileDrawer: '--color-mobile-drawer',
  border: '--color-border',
  textPrimary: '--color-text-primary',
  textSecondary: '--color-text-secondary',
  textMuted: '--color-text-muted',
  primary: '--color-primary',
  primaryContrast: '--color-primary-contrast',
  popover: '--color-popover',
  codeBg: '--color-code-bg',
}

export function resolveAppearanceMode(mode: AppearanceConfig['mode']): ResolvedAppearanceMode {
  if (mode === 'light' || mode === 'dark') return mode

  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  return 'light'
}

export function applyAppearance(
  appearance: AppearanceConfig,
  resolvedMode = resolveAppearanceMode(appearance.mode),
) {
  if (typeof document === 'undefined') return

  const root = document.documentElement
  const defaultPalette = resolvedMode === 'dark' ? darkPalette : lightPalette
  const palette = {
    ...(resolvedMode === 'dark' ? appearance.dark : appearance.light),
    primary: hexToRgbTriplet(appearance.accentColor),
  }

  if (!palette.mobileDrawer || palette.mobileDrawer.includes('/')) {
    palette.mobileDrawer = defaultPalette.mobileDrawer
  }

  root.dataset.theme = resolvedMode
  root.dataset.appearanceMode = appearance.mode
  root.dataset.sidebarTranslucent = String(appearance.sidebarTranslucent)
  root.classList.toggle('dark', resolvedMode === 'dark')
  root.style.colorScheme = resolvedMode

  Object.entries(PALETTE_VARIABLES).forEach(([key, variable]) => {
    root.style.setProperty(variable, palette[key as keyof ThemePalette])
  })

  root.style.setProperty('--font-ui', appearance.uiFont)
  root.style.setProperty('--font-code', appearance.codeFont)
  root.style.setProperty('--appearance-contrast', String(appearance.contrast))
}
