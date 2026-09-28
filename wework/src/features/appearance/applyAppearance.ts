import { resolveThemeVariables } from '@wegent/collaboration/theme'
import type { AppearanceConfig, ResolvedAppearanceMode } from './types'

export function resolveAppearanceMode(mode: AppearanceConfig['mode']): ResolvedAppearanceMode {
  if (mode === 'light' || mode === 'dark') return mode

  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  return 'light'
}

export function applyAppearance(
  appearance: AppearanceConfig,
  resolvedMode = resolveAppearanceMode(appearance.mode)
) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = resolvedMode
  root.dataset.appearanceMode = appearance.mode
  root.dataset.sidebarTranslucent = String(appearance.sidebarTranslucent)
  root.classList.toggle('dark', resolvedMode === 'dark')
  root.style.colorScheme = resolvedMode
  Object.entries(resolveThemeVariables(resolvedMode, appearance)).forEach(([variable, value]) => {
    root.style.setProperty(variable, value)
  })
}
