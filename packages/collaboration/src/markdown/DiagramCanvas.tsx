import Panzoom, { type PanzoomObject } from '@panzoom/panzoom'
import { Minus, Plus, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { DiagramArtifact } from './diagramArtifact'
import { useMarkdownServices } from './MarkdownServices'

export function DiagramCanvas({
  artifact,
  onReady,
  onError,
}: {
  artifact: DiagramArtifact
  onReady: () => void
  onError: () => void
}) {
  const { translate: t } = useMarkdownServices()
  const imageRef = useRef<HTMLImageElement>(null)
  const panzoomRef = useRef<PanzoomObject | null>(null)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const image = imageRef.current
    const canvas = image?.parentElement
    if (!image || !canvas) return
    const panzoom = Panzoom(image, { minScale: 0.4, maxScale: 4, canvas: true })
    panzoomRef.current = panzoom
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      panzoom.zoomWithWheel(event)
    }
    const change = (event: Event) =>
      setScale((event as CustomEvent<{ scale: number }>).detail.scale)
    canvas.addEventListener('wheel', wheel, { passive: false })
    image.addEventListener('panzoomzoom', change)
    return () => {
      canvas.removeEventListener('wheel', wheel)
      image.removeEventListener('panzoomzoom', change)
      panzoom.destroy()
      panzoomRef.current = null
    }
  }, [artifact])
  const controls = [
    {
      id: 'out',
      label: t('workbench.diagram_zoom_out', '缩小'),
      icon: Minus,
      action: 'zoomOut' as const,
      disabled: scale <= 0.4,
    },
    {
      id: 'in',
      label: t('workbench.diagram_zoom_in', '放大'),
      icon: Plus,
      action: 'zoomIn' as const,
      disabled: scale >= 4,
    },
    {
      id: 'reset',
      label: t('workbench.diagram_fit', '适应窗口'),
      icon: RotateCcw,
      action: 'reset' as const,
      disabled: false,
    },
  ]
  return (
    <>
      <div
        className="absolute inset-0 overflow-hidden"
        data-testid="diagram-pan-canvas"
        data-search-excluded
      >
        <img
          ref={imageRef}
          data-testid="diagram-image"
          src={artifact.src}
          alt={t('workbench.diagram_preview', '图表预览')}
          draggable={false}
          decoding="async"
          onLoad={onReady}
          onError={onError}
          className="h-full w-full select-none object-contain p-4"
        />
      </div>
      <div
        data-search-excluded
        className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-lg border border-border bg-background/90 p-1"
      >
        {controls.map(({ id, label, icon: Icon, action, disabled }) => (
          <button
            key={id}
            type="button"
            data-testid={`diagram-zoom-${id}-button`}
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={() => panzoomRef.current?.[action]()}
            className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-50 md:h-7 md:w-7"
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
        <span className="min-w-11 text-center text-xs tabular-nums text-text-secondary">
          {Math.round(scale * 100)}%
        </span>
      </div>
    </>
  )
}
