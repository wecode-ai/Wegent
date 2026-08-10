import { convertFileSrc } from '@tauri-apps/api/core'
import type { ResolvedAppearanceMode } from '@/features/appearance/types'
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

const PLUGIN_ICON_DARK_FALLBACKS: Record<string, string> = {
  '/plugin-icons/github.svg': '/plugin-icons/github-dark.svg',
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

function localPathFromFileUrl(value: string): string {
  if (!value.startsWith('file://')) return value

  try {
    const pathname = decodeURIComponent(new URL(value).pathname)
    return pathname.match(/^\/[a-zA-Z]:\//) ? pathname.slice(1) : pathname
  } catch {
    return value
  }
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

function withDarkFallbackVariant(url: string, appearanceMode: ResolvedAppearanceMode): string {
  if (appearanceMode !== 'dark') return url
  return PLUGIN_ICON_DARK_FALLBACKS[url] ?? url
}

function fallbackPluginIcon(
  pluginKey: string | null | undefined,
  appearanceMode: ResolvedAppearanceMode
): { url: string; isGeneric: boolean } {
  const normalized = (pluginKey || '').trim().toLowerCase()
  let url = normalized ? PLUGIN_ICON_FALLBACKS[normalized] : ''

  if (!url && normalized.includes('github')) url = '/plugin-icons/github.svg'
  if (!url && normalized.includes('gitlab')) url = '/plugin-icons/gitlab.svg'
  if (!url && normalized.includes('weibo')) url = '/plugin-icons/weibo.svg'
  if (!url && (normalized.includes('analytics') || normalized.includes('data'))) {
    url = '/plugin-icons/data-analytics.svg'
  }
  if (!url && (normalized.includes('openai') || normalized.includes('design'))) {
    url = '/plugin-icons/openai.svg'
  }

  if (!url || isGenericPluginIconUrl(url)) return { url: '', isGeneric: true }
  return { url: withDarkFallbackVariant(url, appearanceMode), isGeneric: false }
}

function firstRenderableLogo(candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const resolved = resolvePluginAssetUrl(candidate)
    if (
      resolved &&
      isRenderablePluginLogoUrl(resolved) &&
      !isGenericPluginIconUrl(candidate) &&
      !isGenericPluginIconUrl(resolved)
    ) {
      return resolved
    }
  }
  return ''
}

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
  const logo = resolvePluginLogo(options)
  return logo.isGenericFallback ? '' : logo.url
}

export function installedPluginHasRelativeLogo(plugin: InstalledPlugin): boolean {
  const interfaceData = plugin.spec.interface
  return [interfaceData?.composerIcon, interfaceData?.logo, interfaceData?.logoDark].some(
    isRelativePluginAssetPath
  )
}

export function resolveInstalledPluginLogoUrl(
  plugin: InstalledPlugin,
  appearanceMode: ResolvedAppearanceMode = currentPluginLogoAppearanceMode()
): string {
  const interfaceData = plugin.spec.interface
  return resolvePluginLogoUrl({
    pluginKey: plugin.spec.source.pluginKey,
    logo: resolveInstalledPluginAssetPath(plugin, interfaceData?.logo),
    logoDark: resolveInstalledPluginAssetPath(plugin, interfaceData?.logoDark),
    composerIcon: resolveInstalledPluginAssetPath(plugin, interfaceData?.composerIcon),
    appearanceMode,
  })
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
  isGenericFallback: boolean
  invertInDark: boolean
} {
  const appearanceMode = options.appearanceMode ?? 'light'
  const providedCandidates =
    appearanceMode === 'dark'
      ? [options.logoDark, options.logo, options.composerIcon]
      : [options.logo, options.composerIcon]
  const declaredGenericFallback = providedCandidates.some(isGenericPluginIconUrl)
  const provided = firstRenderableLogo(providedCandidates)

  if (provided) {
    return {
      url: provided,
      source: 'provided',
      isGenericFallback: false,
      invertInDark: false,
    }
  }

  const fallback = declaredGenericFallback
    ? { url: '', isGeneric: true }
    : fallbackPluginIcon(options.pluginKey, appearanceMode)
  return {
    url: fallback.url,
    source: 'fallback',
    isGenericFallback: fallback.isGeneric,
    invertInDark:
      appearanceMode === 'dark' &&
      (fallback.url === '/plugin-icons/openai.svg' ||
        fallback.url === '/plugin-icons/data-analytics.svg'),
  }
}
