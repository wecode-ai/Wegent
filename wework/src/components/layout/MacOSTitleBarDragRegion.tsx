import { cn } from '@/lib/utils'

interface MacOSTitleBarDragRegionProps {
  className?: string
}

export function MacOSTitleBarDragRegion({
  className = 'h-full w-full',
}: MacOSTitleBarDragRegionProps) {
  return (
    <div
      data-testid="macos-titlebar-drag-region"
      className={cn('pointer-events-auto electron-titlebar-drag-region', className)}
      aria-hidden="true"
    />
  )
}
