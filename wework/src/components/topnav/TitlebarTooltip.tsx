import type { ReactNode } from 'react'
import { KeyboardShortcut } from '@/components/common/KeyboardShortcut'
import { cn } from '@/lib/utils'

interface TitlebarTooltipProps {
  label: string
  shortcut?: string
  align?: 'start' | 'center' | 'end'
  testId?: string
  children: ReactNode
}

const tooltipAlignment = {
  start: 'left-0',
  center: 'left-1/2 -translate-x-1/2',
  end: 'right-0',
}

export function TitlebarTooltip({
  label,
  shortcut,
  align = 'center',
  testId,
  children,
}: TitlebarTooltipProps) {
  return (
    <span className="group relative inline-flex shrink-0">
      {children}
      <span
        role="tooltip"
        data-testid={testId}
        className={cn(
          'pointer-events-none absolute top-[calc(100%+6px)] z-system-popover inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-xl border border-border/50 bg-popover/95 px-3 text-sm font-medium leading-[18px] text-text-primary opacity-0 shadow-[0_10px_28px_rgba(0,0,0,0.32)] ring-1 ring-black/10 backdrop-blur-md transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100',
          tooltipAlignment[align]
        )}
      >
        <span>{label}</span>
        {shortcut ? (
          <KeyboardShortcut
            value={shortcut}
            className="h-6 bg-text-primary/10 px-2 text-sm text-text-primary/95"
          />
        ) : null}
      </span>
    </span>
  )
}
