import { convertFileSrc } from '@tauri-apps/api/core'

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

const GENERIC_PLUGIN_ICON_URL = '/plugin-icons/wework.svg'

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

function isGenericPluginIconUrl(value?: string | null): boolean {
  const normalized = value?.trim().split(/[?#]/, 1)[0]?.replace(/\\/g, '/') ?? ''
  return normalized.endsWith(GENERIC_PLUGIN_ICON_URL)
}

function fallbackPluginIcon(pluginKey?: string | null): {
  url: string
  isGeneric: boolean
} {
  const normalized = (pluginKey || '').trim().toLowerCase()
  if (!normalized) return { url: GENERIC_PLUGIN_ICON_URL, isGeneric: true }

  if (PLUGIN_ICON_FALLBACKS[normalized]) {
    const url = PLUGIN_ICON_FALLBACKS[normalized]
    return { url, isGeneric: isGenericPluginIconUrl(url) }
  }

  return { url: GENERIC_PLUGIN_ICON_URL, isGeneric: true }
}

export function resolvePluginLogoUrl(options: {
  pluginKey?: string | null
  logo?: string | null
  composerIcon?: string | null
}): string {
  return resolvePluginLogo(options).url
}

export function resolvePluginLogo(options: {
  pluginKey?: string | null
  logo?: string | null
  composerIcon?: string | null
}): {
  url: string
  source: 'provided' | 'fallback'
  isGenericFallback: boolean
  invertInDark: boolean
} {
  const declaredLogo = options.logo || options.composerIcon
  const resolved = resolvePluginAssetUrl(declaredLogo)
  if (resolved && isRenderablePluginLogoUrl(resolved)) {
    const isGenericFallback =
      isGenericPluginIconUrl(declaredLogo) || isGenericPluginIconUrl(resolved)
    return {
      url: resolved,
      source: isGenericFallback ? 'fallback' : 'provided',
      isGenericFallback,
      invertInDark: false,
    }
  }
  const fallback = fallbackPluginIcon(options.pluginKey)
  return {
    url: fallback.url,
    source: 'fallback',
    isGenericFallback: fallback.isGeneric,
    invertInDark:
      fallback.url === '/plugin-icons/github.svg' ||
      fallback.url === '/plugin-icons/openai.svg' ||
      fallback.url === '/plugin-icons/data-analytics.svg',
  }
}
