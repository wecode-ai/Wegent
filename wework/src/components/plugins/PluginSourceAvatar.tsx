import { useState } from 'react'
import type { PluginDistribution } from './pluginDistribution'
import { pluginNameInitial } from './plugin-assets'

interface PluginSourceAvatarProps {
  className: string
  contrastPad?: boolean
  distribution?: PluginDistribution
  imageTestId?: string
  logoUrl: string
  name: string
  testId?: string
  /** When true (or logo is missing/failed), show the first character of `name`. */
  useInitial?: boolean
}

export function PluginSourceAvatar({
  className,
  contrastPad = false,
  distribution,
  imageTestId,
  logoUrl,
  name,
  testId,
  useInitial = false,
}: PluginSourceAvatarProps) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null)
  const trimmedLogoUrl = logoUrl.trim()
  const imageFailed = Boolean(trimmedLogoUrl) && failedLogoUrl === trimmedLogoUrl
  const showInitial = useInitial || !trimmedLogoUrl || imageFailed

  return (
    <span
      aria-hidden="true"
      className={[
        'plugin-source-avatar',
        className,
        contrastPad && !showInitial ? 'plugin-icon-slot--contrast-pad' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-plugin-distribution={showInitial ? distribution : undefined}
      data-testid={testId}
    >
      {showInitial ? (
        <span className="plugin-source-avatar-initial" data-testid={imageTestId}>
          {pluginNameInitial(name)}
        </span>
      ) : (
        <img
          src={trimmedLogoUrl}
          alt=""
          data-testid={imageTestId}
          onError={() => setFailedLogoUrl(trimmedLogoUrl)}
        />
      )}
    </span>
  )
}
