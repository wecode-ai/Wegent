import { convertFileSrc } from '@tauri-apps/api/core'
import type { ResolvedAppearanceMode } from '@/features/appearance/types'

const PLUGIN_ICON_FALLBACKS: Record<string, string> = {
  github: '/plugin-icons/github.svg',
  gitlab: '/plugin-icons/gitlab.svg',
  'weibo-api': '/plugin-icons/weibo.svg',
  weibo: '/plugin-icons/weibo.svg',
  review: '/plugin-icons/wework.svg',
  'code-review': '/plugin-icons/wework.svg',
  'product-design': '/plugin-icons/openai.svg',
  analytics: '/plugin-icons/data-analytics.svg',
  'data-analytics': '/plugin-icons/data-analytics.svg',
  'plugin-creator': '/plugin-icons/openai.svg',
  ding: '/plugin-icons/wework.svg',
  'release-check': '/plugin-icons/wework.svg',
}

/** Built-in fallback icons that need a light-on-dark variant. */
const PLUGIN_ICON_DARK_FALLBACKS: Record<string, string> = {
  '/plugin-icons/github.svg': '/plugin-icons/github-dark.svg',
}

function isLocalAssetPath(value: string): boolean {
  if (value.startsWith('file://')) return true
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true
  return value.startsWith('/')
}

function localPathFromFileUrl(value: string): string {
  if (!value.startsWith('file://')) return value

  try {
    const pathname = decodeURIComponent(new URL(value).pathname)
    return pathname.match(/^\/[a-zA-Z]:\//) ? pathname.slice(1) : pathname
  } catch {
    return value
  }
}

export function resolvePluginAssetUrl(value?: string | null): string {
  const source = value?.trim()
  if (!source) return ''
  if (!isLocalAssetPath(source)) return source

  try {
    return convertFileSrc(localPathFromFileUrl(source))
  } catch {
    return source
  }
}

function isRenderablePluginLogoUrl(value: string): boolean {
  if (!value) return false
  if (/^(?:data:|https?:|asset:|\/)/.test(value)) return true
  if (value.startsWith('file://')) return true
  return /^[a-zA-Z]:[\\/]/.test(value)
}

function withDarkFallbackVariant(url: string, appearanceMode: ResolvedAppearanceMode): string {
  if (appearanceMode !== 'dark') return url
  return PLUGIN_ICON_DARK_FALLBACKS[url] ?? url
}

function fallbackPluginIconUrl(
  pluginKey: string | null | undefined,
  appearanceMode: ResolvedAppearanceMode
): string {
  const normalized = (pluginKey || '').trim().toLowerCase()
  let url = '/plugin-icons/wework.svg'

  if (normalized) {
    if (PLUGIN_ICON_FALLBACKS[normalized]) {
      url = PLUGIN_ICON_FALLBACKS[normalized]
    } else if (normalized.includes('github')) {
      url = '/plugin-icons/github.svg'
    } else if (normalized.includes('gitlab')) {
      url = '/plugin-icons/gitlab.svg'
    } else if (normalized.includes('weibo')) {
      url = '/plugin-icons/weibo.svg'
    } else if (normalized.includes('analytics') || normalized.includes('data')) {
      url = '/plugin-icons/data-analytics.svg'
    } else if (normalized.includes('openai') || normalized.includes('design')) {
      url = '/plugin-icons/openai.svg'
    }
  }

  return withDarkFallbackVariant(url, appearanceMode)
}

function firstRenderableLogo(candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const resolved = resolvePluginAssetUrl(candidate)
    if (resolved && isRenderablePluginLogoUrl(resolved)) {
      return resolved
    }
  }
  return ''
}

/** Read the resolved theme from the document root when a React appearance hook is unavailable. */
export function currentPluginLogoAppearanceMode(): ResolvedAppearanceMode {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function resolvePluginLogoUrl(options: {
  pluginKey?: string | null
  logo?: string | null
  logoDark?: string | null
  composerIcon?: string | null
  appearanceMode?: ResolvedAppearanceMode
}): string {
  return resolvePluginLogo(options).url
}

export function resolvePluginLogo(options: {
  pluginKey?: string | null
  logo?: string | null
  logoDark?: string | null
  composerIcon?: string | null
  appearanceMode?: ResolvedAppearanceMode
}): {
  url: string
  source: 'provided' | 'fallback'
} {
  const appearanceMode = options.appearanceMode ?? 'light'
  const provided =
    appearanceMode === 'dark'
      ? firstRenderableLogo([options.logoDark, options.logo, options.composerIcon])
      : firstRenderableLogo([options.logo, options.composerIcon])

  if (provided) {
    return {
      url: provided,
      source: 'provided',
    }
  }
  return {
    url: fallbackPluginIconUrl(options.pluginKey, appearanceMode),
    source: 'fallback',
  }
}
