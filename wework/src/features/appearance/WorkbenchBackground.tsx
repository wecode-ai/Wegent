import { useState } from 'react'
import { getWorkbenchBackground } from './backgroundTheme'
import { useOptionalAppearance } from './useAppearance'
import { useWorkbenchBackgroundImage } from './useWorkbenchBackgroundImage'

export function WorkbenchBackground() {
  const appearanceContext = useOptionalAppearance()
  const appearance = appearanceContext?.appearance
  const resolvedMode = appearanceContext?.resolvedMode ?? 'light'
  const background = appearance ? getWorkbenchBackground(appearance, resolvedMode) : null
  const {
    url: imageUrl,
    failed,
    reportLoadError,
  } = useWorkbenchBackgroundImage(background?.imagePath ?? null)
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null)

  if (!imageUrl || failed) return null

  const visibility = (background?.visibility ?? 0) / 100
  const overlayOpacity = 1 - visibility

  return (
    <div data-testid="workbench-background" className="pointer-events-none absolute inset-0">
      <img
        data-testid="workbench-background-image"
        data-image-loaded={loadedImageUrl === imageUrl ? 'true' : 'false'}
        src={imageUrl}
        alt=""
        aria-hidden="true"
        onLoad={() => setLoadedImageUrl(imageUrl)}
        onError={reportLoadError}
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
