import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { MacOSTitleBarDragRegion } from './MacOSTitleBarDragRegion'

export const DESKTOP_TOP_BAR_BUTTON_CLASS =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent p-0 text-[#6b7280] transition-colors hover:bg-black/[0.06] hover:text-[#374151] active:bg-black/[0.10] [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:stroke-[2]'

const MAC_TRAFFIC_LIGHT_LEFT = 19
const MAC_TRAFFIC_LIGHT_DIAMETER = 12
const MAC_TRAFFIC_LIGHT_CENTER_GAP = 20
const MAC_TO_CUSTOM_CONTROL_GAP = 18

export const MAC_NATIVE_TOP_BAR_ACTION_INSET =
  MAC_TRAFFIC_LIGHT_LEFT +
  (MAC_TRAFFIC_LIGHT_CENTER_GAP * 2) +
  MAC_TRAFFIC_LIGHT_DIAMETER +
  MAC_TO_CUSTOM_CONTROL_GAP

interface DesktopTopBarProps {
  left?: ReactNode
  right?: ReactNode
  className?: string
  leftClassName?: string
  rightClassName?: string
  dragRegionClassName?: string
  testId?: string
  style?: CSSProperties
}

export function DesktopTopBar({
  left,
  right,
  className,
  leftClassName,
  rightClassName,
  dragRegionClassName,
  testId = 'desktop-topbar',
  style,
}: DesktopTopBarProps) {
  return (
    <header
      data-testid={testId}
      className={cn(
        'flex h-[52px] w-full shrink-0 items-center bg-background px-6',
        className,
      )}
      style={style}
    >
      {left && (
        <div
          data-testid={`${testId}-left-actions`}
          className={cn('flex shrink-0 items-center gap-3.5', leftClassName)}
        >
          {left}
        </div>
      )}
      <div
        data-testid={`${testId}-drag-region`}
        className={cn('min-w-4 flex-1 self-stretch', dragRegionClassName)}
      >
        <MacOSTitleBarDragRegion className="h-full w-full" />
      </div>
      {right && (
        <div
          data-testid={`${testId}-right-actions`}
          className={cn('ml-auto flex shrink-0 items-center gap-5', rightClassName)}
        >
          {right}
        </div>
      )}
    </header>
  )
}
