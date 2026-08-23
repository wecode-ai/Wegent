import { getCurrentWindow } from '@tauri-apps/api/window'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { cn } from '@/lib/utils'

interface MacOSTitleBarDragRegionProps {
  className?: string
}

export function MacOSTitleBarDragRegion({
  className = 'h-full w-full',
}: MacOSTitleBarDragRegionProps) {
  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isElectronRuntime()) return

    void getCurrentWindow()
      .startDragging()
      .catch(() => undefined)
  }
  return (
    <div
      data-testid="macos-titlebar-drag-region"
      data-tauri-drag-region
      className={cn(
        'pointer-events-auto',
        isElectronRuntime() && 'electron-titlebar-drag-region',
        className
      )}
      onMouseDown={handleMouseDown}
      aria-hidden="true"
    />
  )
}
