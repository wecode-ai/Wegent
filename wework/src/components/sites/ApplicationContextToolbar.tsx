import type { ReactNode } from 'react'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ApplicationContextToolbarProps {
  leading?: ReactNode
  trailing?: ReactNode
  searchLabel: string
  searchPlaceholder: string
  searchTestId: string
  value: string
  onValueChange: (value: string) => void
  className?: string
}

export function ApplicationContextToolbar({
  leading,
  trailing,
  searchLabel,
  searchPlaceholder,
  searchTestId,
  value,
  onValueChange,
  className,
}: ApplicationContextToolbarProps) {
  return (
    <div
      data-testid="applications-context-toolbar"
      className={cn(
        'flex w-full flex-col gap-2 md:h-9 md:flex-row md:items-stretch md:gap-3',
        className
      )}
    >
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <label className="relative min-w-0 flex-1">
        <span className="sr-only">{searchLabel}</span>
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
          aria-hidden="true"
        />
        <input
          data-testid={searchTestId}
          value={value}
          placeholder={searchPlaceholder}
          className="h-11 w-full rounded-lg border border-border/50 bg-background pl-9 pr-3 text-base text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-focus focus:ring-2 focus:ring-focus/15 md:h-9 md:text-sm"
          onChange={event => onValueChange(event.target.value)}
        />
      </label>
      {trailing ? (
        <div className="flex h-11 shrink-0 items-stretch gap-2 md:h-9">{trailing}</div>
      ) : null}
    </div>
  )
}
