import { pluginNameInitial } from '@wegent/chat-core/plugin-reference'
import { useState } from 'react'
export interface ComposerPluginIconProps {
  name: string
  logo: { url: string | null; contrastPad: boolean; source: string }
  className: string
  testId?: string
  initialClassName?: string
}
/** Plugin logos and their missing-image state use the same presentation in both hosts. */
export function ComposerPluginIcon({
  name,
  logo,
  className,
  testId,
  initialClassName = 'text-xs font-medium leading-none text-text-secondary',
}: ComposerPluginIconProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const url = logo.source === 'provided' && logo.url !== failedUrl ? logo.url : null
  return (
    <span
      data-testid={testId}
      className={[className, url && logo.contrastPad ? 'plugin-icon-slot--contrast-pad' : '']
        .filter(Boolean)
        .join(' ')}
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full" onError={() => setFailedUrl(url)} />
      ) : (
        <span className={initialClassName}>{pluginNameInitial(name)}</span>
      )}
    </span>
  )
}
