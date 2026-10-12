import { resolveThemeVariables } from '@wegent/collaboration/theme'
import type { AppearanceConfig, ResolvedAppearanceMode } from './types'

function luminance(rgb: number[]) {
  const channels = rgb.map(value => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function compositeColor(color: string, background: number[]) {
  const [rgb, opacity] = color.split('/')
  const alpha = opacity === undefined ? 1 : Number(opacity)
  return rgb
    .trim()
    .split(/\s+/)
    .map((value, index) => Number(value) * alpha + background[index] * (1 - alpha))
}

function sidebarAttentionColor(variables: Record<string, string>) {
  const accent = variables['--color-primary'].split(' ').map(Number)
  const canvas = compositeColor(variables['--color-bg-base'], [0, 0, 0])
  const sidebar = compositeColor(variables['--color-sidebar'], canvas)
  const backgrounds = [
    sidebar,
    compositeColor(variables['--color-sidebar-hover'], sidebar),
    compositeColor(variables['--color-sidebar-active'], sidebar),
  ].map(surface => luminance(accent.map((channel, index) => channel * 0.1 + surface[index] * 0.9)))
  const contrast = (foreground: number) =>
    Math.min(
      ...backgrounds.map(
        background =>
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
      )
    )
  const target = contrast(0) >= contrast(1) ? 0 : 255
  // Preserve the selected hue, adjusting brightness only when the pale fill needs more contrast.
  for (let step = 0; step <= 100; step += 1) {
    const foreground = accent.map(channel =>
      Math.round(channel + ((target - channel) * step) / 100)
    )
    if (contrast(luminance(foreground)) >= 3) return foreground.join(' ')
  }
  return `${target} ${target} ${target}`
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
  root.style.setProperty('--color-sidebar-attention', sidebarAttentionColor(variables))
}
