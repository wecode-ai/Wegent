import { createPluginAssetResolver } from '@wegent/chat-core/plugin-assets'
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
} = createPluginAssetResolver(
  path => `/wework/executor/v1/plugin-image?path=${encodeURIComponent(path)}`
)
