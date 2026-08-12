import { useMemo, useState } from 'react'
import { pluginNameInitial, resolvePluginLogo } from '@/components/plugins/plugin-assets'
import { useOptionalAppearance } from '@/features/appearance'
import { composerAppPluginKey } from '@/features/plugins/composerPluginMetadata'
import type { LocalDeviceApp } from '@/types/api'

interface ComposerPluginIconProps {
  app: LocalDeviceApp
  className: string
  testId?: string
  /** Shown when the package has no logo (or the image fails). */
  initialClassName?: string
  /** @deprecated Prefer initialClassName; kept for call-site compatibility. */
  fallbackClassName?: string
}

/** Render the plugin package logo; fall back to the plugin name initial. */
export function ComposerPluginIcon({
  app,
  className,
  testId,
  initialClassName = 'text-xs font-medium leading-none text-text-secondary',
}: ComposerPluginIconProps) {
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
  const pluginKey = composerAppPluginKey(app)
  const logo = resolvePluginLogo({
    pluginKey,
    logo: app.logoUrl,
    logoDark: app.logoUrlDark,
    appearanceMode,
  })
  const logoCandidates = useMemo(
    () => (logo.source === 'provided' && logo.url ? [logo.url] : []),
    [logo.source, logo.url]
  )
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null)
  const activeLogoUrl =
    logoCandidates.find(url => !(failedLogoUrl && failedLogoUrl === url)) ?? null
  const contrastPad = Boolean(activeLogoUrl) && logo.contrastPad

  return (
    <span
      data-testid={testId}
      className={[className, contrastPad ? 'plugin-icon-slot--contrast-pad' : '']
        .filter(Boolean)
        .join(' ')}
    >
      {activeLogoUrl ? (
        <img
          src={activeLogoUrl}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailedLogoUrl(activeLogoUrl)}
        />
      ) : (
        <span className={initialClassName}>{pluginNameInitial(app.name)}</span>
      )}
    </span>
  )
}
