import { useMemo, useState } from 'react'
import { backgroundImageUrl } from './backgroundImage'
import { useOptionalAppearance } from './useAppearance'

export function WorkbenchBackground() {
  const appearanceContext = useOptionalAppearance()
  const appearance = appearanceContext?.appearance
  const imageUrl = useMemo(
    () => backgroundImageUrl(appearance?.backgroundImagePath ?? null),
    [appearance?.backgroundImagePath]
  )
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null)
  if (!imageUrl || imageUrl === failedImageUrl) return null

  const visibility = (appearance?.backgroundVisibility ?? 0) / 100
  const overlayOpacity = 1 - visibility

  return (
    <div data-testid="workbench-background" className="pointer-events-none absolute inset-0">
      <img
        src={imageUrl}
        alt=""
        aria-hidden="true"
        onError={() => setFailedImageUrl(imageUrl)}
        className="absolute inset-0 h-full w-full object-cover"
        style={{
          filter: appearance?.backgroundBlur ? `blur(${appearance.backgroundBlur}px)` : undefined,
          transform: appearance?.backgroundBlur
            ? `scale(${1 + appearance.backgroundBlur / 500})`
            : undefined,
        }}
      />
      <div
        data-testid="workbench-background-overlay"
        className="absolute inset-0 bg-background"
        style={{ opacity: overlayOpacity }}
      />
    </div>
  )
}
