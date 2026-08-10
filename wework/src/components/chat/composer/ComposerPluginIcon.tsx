import { useMemo, useState } from 'react'
import { pluginNameInitial, resolvePluginLogo } from '@/components/plugins/plugin-assets'
import { useOptionalAppearance } from '@/features/appearance'
import { composerAppPluginKey } from '@/features/plugins/composerPluginMetadata'
import type { LocalDeviceApp } from '@/types/api'

interface ComposerPluginIconProps {
  app: LocalDeviceApp
  className: string
  initialClassName: string
  testId?: string
}

export function ComposerPluginIcon({
  app,
  className,
  initialClassName,
  testId,
}: ComposerPluginIconProps) {
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
  const pluginKey = composerAppPluginKey(app)
  const logoCandidates = useMemo(() => {
    const provided = resolvePluginLogo({
      pluginKey,
      logo: app.logoUrl,
      logoDark: app.logoUrlDark,
      appearanceMode,
    })
    const fallback = resolvePluginLogo({ pluginKey, appearanceMode })
    return [provided, fallback]
      .filter(logo => !logo.isGenericFallback && Boolean(logo.url))
      .map(logo => logo.url)
      .filter((url, index, urls) => urls.indexOf(url) === index)
  }, [app.logoUrl, app.logoUrlDark, appearanceMode, pluginKey])
  const [failedLogoUrlsByCandidate, setFailedLogoUrlsByCandidate] = useState<
    Record<string, string[]>
  >({})
  const logoCandidateKey = logoCandidates.join('\n')
  const failedLogoUrls = failedLogoUrlsByCandidate[logoCandidateKey] ?? []
  const logoUrl = logoCandidates.find(url => !failedLogoUrls.includes(url))

  return (
    <span data-testid={testId} className={className}>
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          className="h-full w-full object-cover"
          onError={() =>
            setFailedLogoUrlsByCandidate(current => ({
              ...current,
              [logoCandidateKey]: [...(current[logoCandidateKey] ?? []), logoUrl],
            }))
          }
        />
      ) : (
        <span className={initialClassName}>{pluginNameInitial(app.name)}</span>
      )}
    </span>
  )
}
