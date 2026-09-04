import type { ResolvedAppearanceMode } from '@/features/appearance/types'
import type { InstalledPlugin } from '@/types/api'
import { desktopFileUrl } from '@/components/chat/assistantMarkdownLinks'

/** Legacy host neutral icon — never show as a real package logo; UI uses name initials. */
const NEUTRAL_PLUGIN_ICON = '/plugin-icons/wework.svg'

export type ResolvedPluginLogo = {
  url: string
  source: 'provided' | 'fallback'
  /** Dark theme soft pad when the package has no logoDark and a light logo is shown. */
  contrastPad: boolean
}

export function pluginNameInitial(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?'
}

export function isNeutralPluginIconUrl(value?: string | null): boolean {
  const normalized = value?.trim().split(/[?#]/, 1)[0]?.replace(/\\/g, '/') ?? ''
  return (
    normalized === NEUTRAL_PLUGIN_ICON ||
    normalized.endsWith('/plugin-icons/wework.svg') ||
    normalized.endsWith('plugin-icons/wework.svg')
  )
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

  return desktopFileUrl(localPathFromFileUrl(source))
}

function isRenderablePluginLogoUrl(value: string): boolean {
  if (!value || isNeutralPluginIconUrl(value)) return false
  if (/^(?:data:|https?:|asset:|\/)/.test(value)) return true
  if (value.startsWith('file://')) return true
  return /^[a-zA-Z]:[\\/]/.test(value)
}

function firstRenderableLogo(candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (isNeutralPluginIconUrl(candidate)) continue
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

export function installedPluginHasRelativeLogo(plugin: InstalledPlugin): boolean {
  const interfaceData = plugin.spec.interface
  return [interfaceData?.composerIcon, interfaceData?.logo, interfaceData?.logoDark].some(
    isRelativePluginAssetPath
  )
}

type PluginLogoInterfaceFields = {
  logo?: string | null
  logoDark?: string | null
  composerIcon?: string | null
}

/** Resolve logos from the installed plugin package (relative paths → absolute file URLs). */
export function resolveInstalledPluginLogoUrl(
  plugin: InstalledPlugin,
  appearanceMode: ResolvedAppearanceMode = currentPluginLogoAppearanceMode(),
  interfaceOverride?: PluginLogoInterfaceFields | null
): string {
  const interfaceData = interfaceOverride ?? plugin.spec.interface
  return resolvePluginLogoUrl({
    pluginKey: plugin.spec.source.pluginKey,
    logo: resolveInstalledPluginAssetPath(plugin, interfaceData?.logo) || interfaceData?.logo,
    logoDark:
      resolveInstalledPluginAssetPath(plugin, interfaceData?.logoDark) || interfaceData?.logoDark,
    composerIcon:
      resolveInstalledPluginAssetPath(plugin, interfaceData?.composerIcon) ||
      interfaceData?.composerIcon,
    appearanceMode,
  })
}

/**
 * Resolve a package logo. Missing / host-neutral icons return an empty URL with
 * `source: 'fallback'` so UI can render the plugin name initial instead of wework.svg.
 */
export function resolvePluginLogo(options: {
  pluginKey?: string | null
  logo?: string | null
  logoDark?: string | null
  composerIcon?: string | null
  appearanceMode?: ResolvedAppearanceMode
}): ResolvedPluginLogo {
  const appearanceMode = options.appearanceMode ?? 'light'
  const darkLogo = firstRenderableLogo([options.logoDark])
  const lightLogo = firstRenderableLogo([options.logo, options.composerIcon])

  if (appearanceMode === 'dark') {
    if (darkLogo) {
      return { url: darkLogo, source: 'provided', contrastPad: false }
    }
    if (lightLogo) {
      return { url: lightLogo, source: 'provided', contrastPad: true }
    }
    return { url: '', source: 'fallback', contrastPad: false }
  }

  if (lightLogo) {
    return { url: lightLogo, source: 'provided', contrastPad: false }
  }
  return { url: '', source: 'fallback', contrastPad: false }
}

type PluginLogoFields = {
  logo?: string | null
  logoDark?: string | null
  composerIcon?: string | null
}

/**
 * Prefer the first interface that yields a real package logo. Used when installed
 * rows and marketplace listings may disagree after a partial sync.
 */
export function resolvePreferredPluginLogo(options: {
  pluginKey?: string | null
  appearanceMode?: ResolvedAppearanceMode
  interfaces: Array<PluginLogoFields | null | undefined>
}): ResolvedPluginLogo {
  const appearanceMode = options.appearanceMode ?? 'light'
  for (const interfaceData of options.interfaces) {
    if (!interfaceData) continue
    const logo = resolvePluginLogo({
      pluginKey: options.pluginKey,
      logo: interfaceData.logo,
      logoDark: interfaceData.logoDark,
      composerIcon: interfaceData.composerIcon,
      appearanceMode,
    })
    if (logo.source === 'provided') return logo
  }
  return resolvePluginLogo({
    pluginKey: options.pluginKey,
    appearanceMode,
  })
}
