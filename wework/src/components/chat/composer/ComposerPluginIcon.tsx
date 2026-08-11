import { Boxes } from 'lucide-react'
import { useState } from 'react'
import { resolvePluginLogo } from '@/components/plugins/plugin-assets'
import { useOptionalAppearance } from '@/features/appearance'
import { composerAppPluginKey } from '@/features/plugins/composerPluginMetadata'
import type { LocalDeviceApp } from '@/types/api'

interface ComposerPluginIconProps {
  app: LocalDeviceApp
  className: string
  testId?: string
}

export function ComposerPluginIcon({ app, className, testId }: ComposerPluginIconProps) {
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
  const pluginKey = composerAppPluginKey(app)
  const logo = resolvePluginLogo({
    pluginKey,
    logo: app.logoUrl,
    logoDark: app.logoUrlDark,
    appearanceMode,
  })
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null)
  const showFallback = !logo.url || failedLogoUrl === logo.url

  return (
    <span
      data-testid={testId}
      className={[className, logo.contrastPad ? 'plugin-icon-slot--contrast-pad' : '']
        .filter(Boolean)
        .join(' ')}
    >
      {showFallback ? (
        <Boxes className="h-4 w-4 text-text-muted" />
      ) : (
        <img
          src={logo.url}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailedLogoUrl(logo.url)}
        />
      )}
    </span>
  )
}
