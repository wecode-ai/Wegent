import type { LucideIcon } from 'lucide-react'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface DesktopSidebarHeaderProps {
  actions?: ReactNode
  actionsTestId?: string
  title?: string
}

export function DesktopSidebarHeader({
  actions,
  actionsTestId,
  title = 'Wework',
}: DesktopSidebarHeaderProps) {
  return (
    <div className="mb-1 flex h-9 shrink-0 items-center justify-between px-2">
      <span className="min-w-0 truncate text-heading-sm font-semibold leading-6 text-[rgb(var(--color-sidebar-text-primary))]">
        {title}
      </span>
      {actions && (
        <div data-testid={actionsTestId} className="flex items-center gap-1">
          {actions}
        </div>
      )}
    </div>
  )
}

interface DesktopSidebarNavItemProps {
  icon: LucideIcon
  label: string
  onClick: () => void
  selected?: boolean
  testId?: string
}

export function DesktopSidebarNavItem({
  icon: Icon,
  label,
  onClick,
  selected,
  testId,
}: DesktopSidebarNavItemProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-current={selected ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'flex h-[30px] w-full items-center gap-2 rounded-[10px] px-2 text-left text-base font-normal leading-5',
        selected
          ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
          : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]'
      )}
    >
      <Icon className="h-4 w-4 text-current" />
      <span>{label}</span>
    </button>
  )
}

interface DesktopSidebarSectionHeaderProps {
  children: ReactNode
  expanded: boolean
  hasContent: boolean
  iconTestId: string
  onToggle: () => void
  title: string
  toggleTestId: string
}

export function DesktopSidebarSectionHeader({
  children,
  expanded,
  hasContent,
  iconTestId,
  onToggle,
  title,
  toggleTestId,
}: DesktopSidebarSectionHeaderProps) {
  const iconVisibilityClass =
    hasContent && !expanded ? 'opacity-100' : 'opacity-0 group-hover/section:opacity-100'

  return (
    <div className="group/section relative mb-2 flex h-[30px] items-center px-2.5">
      <button
        type="button"
        data-testid={toggleTestId}
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md pr-8 text-left"
      >
        <span className="truncate text-xs font-medium leading-4 text-[rgb(var(--color-sidebar-text-muted))] opacity-75">
          {title}
        </span>
        <ChevronRight
          data-testid={iconTestId}
          className={cn(
            'h-4 w-4 shrink-0 text-[rgb(var(--color-sidebar-text-muted))] transition-[opacity,transform]',
            expanded ? 'rotate-90' : 'rotate-0',
            iconVisibilityClass
          )}
        />
      </button>
      <div
        data-testid={`${toggleTestId}-actions`}
        className="pointer-events-none absolute right-2.5 top-1/2 z-[70] flex -translate-y-1/2 items-center opacity-0 transition-opacity group-hover/section:pointer-events-auto group-hover/section:opacity-100 hover:pointer-events-auto hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
      >
        {children}
      </div>
    </div>
  )
}
