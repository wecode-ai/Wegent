import { useMemo, useState } from 'react'
import { backgroundImageUrl } from './backgroundImage'
import { getWorkbenchBackground } from './backgroundTheme'
import { useOptionalAppearance } from './useAppearance'

export function WorkbenchBackground() {
  const appearanceContext = useOptionalAppearance()
  const appearance = appearanceContext?.appearance
  const resolvedMode = appearanceContext?.resolvedMode ?? 'light'
  const background = appearance ? getWorkbenchBackground(appearance, resolvedMode) : null
  const imageUrl = useMemo(
    () => backgroundImageUrl(background?.imagePath ?? null),
    [background?.imagePath]
  )
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null)
  if (!imageUrl || imageUrl === failedImageUrl) return null

  const visibility = (background?.visibility ?? 0) / 100
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
          filter: background?.blur ? `blur(${background.blur}px)` : undefined,
          transform: background?.blur ? `scale(${1 + background.blur / 500})` : undefined,
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
