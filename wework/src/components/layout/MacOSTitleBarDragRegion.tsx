import { getCurrentWindow } from '@tauri-apps/api/window'

interface MacOSTitleBarDragRegionProps {
  className?: string
}

export function MacOSTitleBarDragRegion({
  className = 'h-full w-full',
}: MacOSTitleBarDragRegionProps) {
  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return

    void getCurrentWindow().startDragging().catch(() => undefined)
  }

  return (
    <div
      data-testid="macos-titlebar-drag-region"
      data-tauri-drag-region
      className={className}
      onMouseDown={handleMouseDown}
      aria-hidden="true"
    />
  )
}
