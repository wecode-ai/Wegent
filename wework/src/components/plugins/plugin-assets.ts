import { convertFileSrc } from '@tauri-apps/api/core'
import type { InstalledPlugin } from '@/types/api'

const PLUGIN_ICON_FALLBACKS: Record<string, string> = {
  github: '/plugin-icons/github.svg',
  gitlab: '/plugin-icons/gitlab.svg',
  'weibo-api': '/plugin-icons/weibo.svg',
  weibo: '/plugin-icons/weibo.svg',
  'product-design': '/plugin-icons/openai.svg',
  analytics: '/plugin-icons/data-analytics.svg',
  'data-analytics': '/plugin-icons/data-analytics.svg',
  'plugin-creator': '/plugin-icons/openai.svg',
}

const LEGACY_GENERIC_PLUGIN_ICON_URL = '/plugin-icons/wework.svg'

export function pluginNameInitial(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?'
}

function isLocalAssetPath(value: string): boolean {
  if (value.startsWith('file://')) return true
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true
  return value.startsWith('/')
}

export function isRelativePluginAssetPath(value?: string | null): boolean {
  const source = value?.trim()
  if (!source || isLocalAssetPath(source)) return false
  return !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(source)
}

function pluginRootFromComponentPath(value?: string | null): string | null {
  const source = value?.trim()
  if (!source || !isLocalAssetPath(source)) return null
  const normalized = localPathFromFileUrl(source).replace(/\\/g, '/')
  const marker = ['/skills/', '/agents/', '/commands/']
    .map(directory => normalized.lastIndexOf(directory))
    .find(index => index > 0)
  return marker === undefined ? null : normalized.slice(0, marker)
}

function installedPluginRoot(plugin: InstalledPlugin): string | null {
  const components = plugin.spec.components
  const paths = [
    ...(components.skills ?? []).map(component => component.path),
    ...(components.agents ?? []).map(component => component.path),
    ...(components.commands ?? []).map(component => component.path),
  ]
  return paths.map(pluginRootFromComponentPath).find(Boolean) ?? null
}

function resolveInstalledPluginAssetPath(plugin: InstalledPlugin, value?: string | null): string {
  const source = value?.trim()
  if (!source || !isRelativePluginAssetPath(source)) return source ?? ''
  const root = installedPluginRoot(plugin)
  if (!root) return source
  const segments = source.replace(/\\/g, '/').split('/')
  const safeSegments: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') return ''
    safeSegments.push(segment)
  }
  return safeSegments.length > 0 ? `${root}/${safeSegments.join('/')}` : ''
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
  return normalized.endsWith(LEGACY_GENERIC_PLUGIN_ICON_URL)
}

function fallbackPluginIcon(pluginKey?: string | null): {
  url: string
  isGeneric: boolean
} {
  const normalized = (pluginKey || '').trim().toLowerCase()
  if (!normalized) return { url: '', isGeneric: true }

  if (PLUGIN_ICON_FALLBACKS[normalized]) {
    const url = PLUGIN_ICON_FALLBACKS[normalized]
    return { url, isGeneric: isGenericPluginIconUrl(url) }
  }

  return { url: '', isGeneric: true }
}

export function resolvePluginLogoUrl(options: {
  pluginKey?: string | null
  logo?: string | null
  composerIcon?: string | null
}): string {
  const logo = resolvePluginLogo(options)
  return logo.isGenericFallback ? '' : logo.url
}

export function installedPluginHasRelativeLogo(plugin: InstalledPlugin): boolean {
  const interfaceData = plugin.spec.interface
  return isRelativePluginAssetPath(interfaceData?.composerIcon || interfaceData?.logo)
}

export function resolveInstalledPluginLogoUrl(plugin: InstalledPlugin): string {
  const interfaceData = plugin.spec.interface
  const declaredLogo = interfaceData?.composerIcon || interfaceData?.logo
  return resolvePluginLogoUrl({
    pluginKey: plugin.spec.source.pluginKey,
    logo: resolveInstalledPluginAssetPath(plugin, declaredLogo),
  })
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
