import { ComposerPluginIcon as SharedComposerPluginIcon } from '@wegent/collaboration/composer/ComposerPluginIcon'
import { resolvePluginLogo } from '@/components/plugins/plugin-assets'
import { useOptionalAppearance } from '@/features/appearance'
import { composerAppPluginKey } from '@/features/plugins/composerPluginMetadata'
import type { LocalDeviceApp } from '@/types/api'
interface ComposerPluginIconProps {
  app: LocalDeviceApp
  className: string
  testId?: string
  initialClassName?: string
}
export function ComposerPluginIcon({ app, ...props }: ComposerPluginIconProps) {
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
  return (
    <SharedComposerPluginIcon
      {...props}
      name={app.name}
      logo={resolvePluginLogo({
        pluginKey: composerAppPluginKey(app),
        logo: app.logoUrl,
        logoDark: app.logoUrlDark,
        appearanceMode,
      })}
    />
  )
}
