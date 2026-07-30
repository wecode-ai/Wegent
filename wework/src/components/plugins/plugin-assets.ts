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

function fallbackPluginIconUrl(pluginKey?: string | null): string {
  const normalized = (pluginKey || '').trim().toLowerCase()
  if (!normalized) return '/plugin-icons/wework.svg'

  if (PLUGIN_ICON_FALLBACKS[normalized]) {
    return PLUGIN_ICON_FALLBACKS[normalized]
  }

  if (normalized.includes('github')) return '/plugin-icons/github.svg'
  if (normalized.includes('gitlab')) return '/plugin-icons/gitlab.svg'
  if (normalized.includes('weibo')) return '/plugin-icons/weibo.svg'
  if (normalized.includes('analytics') || normalized.includes('data')) {
    return '/plugin-icons/data-analytics.svg'
  }
  if (normalized.includes('openai') || normalized.includes('design')) {
    return '/plugin-icons/openai.svg'
  }

  return '/plugin-icons/wework.svg'
}

export function resolvePluginLogoUrl(options: {
  pluginKey?: string | null
  logo?: string | null
  composerIcon?: string | null
}): string {
  const resolved = resolvePluginAssetUrl(options.logo || options.composerIcon)
  if (resolved && isRenderablePluginLogoUrl(resolved)) return resolved
  return fallbackPluginIconUrl(options.pluginKey)
}
