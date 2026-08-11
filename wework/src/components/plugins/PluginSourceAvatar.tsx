import { Boxes } from 'lucide-react'
import type { PluginDistribution } from './pluginDistribution'

interface PluginSourceAvatarProps {
  className: string
  contrastPad?: boolean
  distribution?: PluginDistribution
  imageTestId?: string
  logoUrl: string
  name: string
  testId?: string
}

export function PluginSourceAvatar({
  className,
  contrastPad = false,
  imageTestId,
  logoUrl,
  testId,
}: PluginSourceAvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={[
        'plugin-source-avatar',
        className,
        contrastPad ? 'plugin-icon-slot--contrast-pad' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid={testId}
    >
      {logoUrl ? (
        <img src={logoUrl} alt="" data-testid={imageTestId} />
      ) : (
        <Boxes className="h-5 w-5 text-text-muted" data-testid={imageTestId} />
      )}
    </span>
  )
}
