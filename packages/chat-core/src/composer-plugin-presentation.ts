import type { InstalledPlugin, PluginInterface } from './installed-plugin-types'
import { pluginTrialTemplates } from './plugin-trial-templates'
import type { ComposerPluginPresentation } from './composer-plugin-metadata'

/** Hosts resolve local image URLs; metadata, missing logos and templates have one shape. */
export function createComposerPluginPresentation(
  resolveLogo: (
    plugin: InstalledPlugin,
    appearance: 'light' | 'dark',
    interfaceData?: PluginInterface | null
  ) => string
) {
  return (
    plugin: InstalledPlugin,
    interfaceData = plugin.spec.interface
  ): ComposerPluginPresentation => ({
    shortDescription: interfaceData?.shortDescription,
    logoUrl: resolveLogo(plugin, 'light', interfaceData) || null,
    logoUrlDark: resolveLogo(plugin, 'dark', interfaceData) || null,
    trialTemplates: pluginTrialTemplates(plugin),
  })
}
