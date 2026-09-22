import { createPluginAssetResolver } from '@wegent/chat-core/plugin-assets'
import { desktopFileUrl } from '@/components/chat/assistantMarkdownLinks'
export { pluginNameInitial } from '@wegent/chat-core/plugin-reference'
export type { ResolvedPluginLogo } from '@wegent/chat-core/plugin-assets'
export const {
  isNeutralPluginIconUrl,
  isRelativePluginAssetPath,
  resolvePluginAssetUrl,
  currentPluginLogoAppearanceMode,
  resolvePluginLogoUrl,
  installedPluginHasRelativeLogo,
  resolveInstalledPluginLogoUrl,
  resolvePluginLogo,
  resolvePreferredPluginLogo,
} = createPluginAssetResolver(desktopFileUrl)
