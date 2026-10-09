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
  const variables = resolveThemeVariables(resolvedMode, appearance)
  Object.entries(variables).forEach(([variable, value]) => {
    root.style.setProperty(variable, value)
  })
  const channels = variables['--color-primary'].split(' ').map(value => {
    const channel = Number(value) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  const blackContrast = (luminance + 0.05) / 0.05
  const whiteContrast = 1.05 / (luminance + 0.05)
  root.style.setProperty(
    '--color-sidebar-attention',
    blackContrast >= whiteContrast ? '0 0 0' : '255 255 255'
  )
}
