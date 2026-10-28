import { Image } from 'lucide-react'
import { useWorkbenchBackgroundImage } from './useWorkbenchBackgroundImage'

interface WorkbenchBackgroundPreviewProps {
  imagePath: string | null
  visibility: number
  blur: number
  /** Appended to the preview test id so each background slot stays identifiable. */
  testIdSuffix: string
}

export function WorkbenchBackgroundPreview({
  imagePath,
  visibility,
  blur,
  testIdSuffix,
}: WorkbenchBackgroundPreviewProps) {
  const { url, failed } = useWorkbenchBackgroundImage(imagePath)
  const backgroundUrl = failed ? null : url

  return (
    <div
      data-testid={`appearance-background-preview${testIdSuffix}`}
      className="relative min-h-32 overflow-hidden rounded-lg border border-border bg-surface"
    >
      {backgroundUrl ? (
        <>
          <img
            src={backgroundUrl}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover"
            style={{
              filter: blur ? `blur(${blur}px)` : undefined,
              transform: blur ? `scale(${1 + blur / 500})` : undefined,
            }}
          />
          <div
            className="absolute inset-0 bg-background"
            style={{ opacity: 1 - visibility / 100 }}
          />
        </>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-text-muted">
          <Image className="h-6 w-6" />
        </div>
      )}
    </div>
  )
}
