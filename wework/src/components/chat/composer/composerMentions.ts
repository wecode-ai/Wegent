import { parsePluginUri } from '@/features/plugins/pluginNavigation'
import { composerAppPluginKey } from '@/features/plugins/composerPluginMetadata'
import {
  currentPluginLogoAppearanceMode,
  resolvePluginLogo,
} from '@/components/plugins/plugin-assets'
import { getComposerApps } from './composerAppsSnapshot'

export * from '@wegent/collaboration/composer/composerMentions'
import {
  resolveComposerMentionBrandIcon as resolveSharedBrandIcon,
  createComposerMentionElement as createSharedMentionElement,
  type ComposerMentionPayload,
} from '@wegent/collaboration/composer/composerMentions'

function logoFromComposerAppInventory(href: string): { url: string; contrastPad: boolean } | null {
  const pluginReference = parsePluginUri(href)
  const appId = href.startsWith('app://') ? href.slice('app://'.length).trim() : ''
  const pluginKey = (pluginReference?.pluginName || appId).trim().toLowerCase()
  if (!pluginKey) return null

  const apps = getComposerApps()
  const app =
    apps.find(item => composerAppPluginKey(item).trim().toLowerCase() === pluginKey) ||
    apps.find(item => (item.pluginKey || '').trim().toLowerCase() === pluginKey) ||
    apps.find(item => item.id.replace(/^(plugin:|wegent:)/, '').toLowerCase() === pluginKey)
  if (!app) return null

  const logo = resolvePluginLogo({
    pluginKey: composerAppPluginKey(app),
    logo: app.logoUrl,
    logoDark: app.logoUrlDark,
    appearanceMode: currentPluginLogoAppearanceMode(),
  })
  if (logo.source !== 'provided' || !logo.url) return null
  return { url: logo.url, contrastPad: logo.contrastPad }
}

function resolveNativeMentionIcon(href: string): { url: string; contrastPad: boolean } | null {
  const fromInventory = logoFromComposerAppInventory(href)
  if (fromInventory) return fromInventory

  const appearanceMode = currentPluginLogoAppearanceMode()
  const pluginReference = parsePluginUri(href)
  if (pluginReference) {
    const logo = resolvePluginLogo({
      pluginKey: pluginReference.pluginName,
      appearanceMode,
    })
    if (logo.source !== 'provided' || !logo.url) return null
    return { url: logo.url, contrastPad: logo.contrastPad }
  }

  if (href.startsWith('app://')) {
    const appId = href.slice('app://'.length).trim()
    if (!appId) return null
    const logo = resolvePluginLogo({ pluginKey: appId, appearanceMode })
    if (logo.source !== 'provided' || !logo.url) return null
    return { url: logo.url, contrastPad: logo.contrastPad }
  }

  return null
}

export function resolveComposerMentionBrandIcon(href: string) {
  return resolveSharedBrandIcon(href, resolveNativeMentionIcon)
}

export function resolveComposerMentionBrandIconUrl(href: string) {
  return resolveComposerMentionBrandIcon(href)?.url ?? null
}

export function createComposerMentionElement(payload: ComposerMentionPayload) {
  return createSharedMentionElement(payload, resolveNativeMentionIcon)
}
