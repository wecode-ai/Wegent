import { Boxes } from 'lucide-react'
import { useState } from 'react'
import { resolvePluginAssetUrl } from './plugin-assets'

interface PluginLogoProps {
  source?: string | null
  imageClassName?: string
  fallbackClassName?: string
  testId?: string
}

export function PluginLogo({
  source,
  imageClassName = 'h-full w-full object-cover',
  fallbackClassName = 'h-5 w-5',
  testId,
}: PluginLogoProps) {
  const resolvedSource = resolvePluginAssetUrl(source)
  const [failedSource, setFailedSource] = useState('')

  if (!resolvedSource || failedSource === resolvedSource) {
    return (
      <Boxes
        aria-hidden="true"
        className={fallbackClassName}
        data-testid={testId ? `${testId}-fallback` : undefined}
      />
    )
  }

  return (
    <img
      src={resolvedSource}
      alt=""
      className={imageClassName}
      data-testid={testId ? `${testId}-image` : undefined}
      onError={() => setFailedSource(resolvedSource)}
    />
  )
}
