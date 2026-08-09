import { useState } from 'react'
import type { PluginDistribution } from './pluginDistribution'
import { pluginNameInitial } from './plugin-assets'

interface PluginSourceAvatarProps {
  className: string
  distribution: PluginDistribution
  imageTestId?: string
  invertLogoInDark?: boolean
  logoUrl: string
  name: string
  testId?: string
  useInitial: boolean
}

export function PluginSourceAvatar({
  className,
  distribution,
  imageTestId,
  invertLogoInDark = false,
  logoUrl,
  name,
  testId,
  useInitial,
}: PluginSourceAvatarProps) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null)
  const imageFailed = failedLogoUrl === logoUrl
  const showInitial = useInitial || imageFailed

  return (
    <span
      aria-hidden="true"
      className={`plugin-source-avatar ${className}`}
      data-plugin-distribution={showInitial ? distribution : undefined}
      data-testid={testId}
    >
      {showInitial ? (
        <span className="plugin-source-avatar-initial" data-testid={imageTestId}>
          {pluginNameInitial(name)}
        </span>
      ) : (
        <img
          src={logoUrl}
          alt=""
          className={invertLogoInDark ? 'plugin-source-avatar-logo-invert-dark' : undefined}
          data-testid={imageTestId}
          onError={() => setFailedLogoUrl(logoUrl)}
        />
      )}
    </span>
  )
}
