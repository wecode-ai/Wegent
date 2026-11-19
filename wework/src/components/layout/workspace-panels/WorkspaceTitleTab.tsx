import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

/** Shared title-tab treatment for task and collaboration workspace panels. */
export function WorkspaceTitleTab({
  testId,
  active,
  label,
  title,
  icon,
  onSelect,
  onClose,
  id,
  controls,
}: {
  testId: string
  active: boolean
  label: string
  title?: string
  icon: ReactNode
  onSelect(): void
  onClose?(): void
  id?: string
  controls?: string
}) {
  const { t } = useTranslation('common')
  return (
    <div
      id={id}
      data-testid={testId}
      role="tab"
      aria-selected={active}
      aria-controls={controls}
      title={title}
      tabIndex={active ? 0 : -1}
      onClick={onSelect}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          const list = event.currentTarget.closest('[role="tablist"]')
          const tabs = Array.from(list?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
          const index = tabs.indexOf(event.currentTarget)
          if (index < 0) return
          event.preventDefault()
          event.stopPropagation()
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
          tabs[next]?.click()
          tabs[next]?.focus()
          return
        }
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onSelect()
      }}
      className={cn(
        'group/tab relative flex h-11 min-w-0 max-w-[200px] shrink-0 cursor-pointer items-stretch rounded-md text-left text-xs font-medium transition-colors focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus pointer-events-auto md:h-8 [@media(pointer:coarse)]:h-11',
        active
          ? 'bg-muted text-text-primary'
          : 'text-text-secondary hover:bg-muted hover:text-text-primary'
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        onClick={event => {
          event.stopPropagation()
          event.currentTarget.parentElement?.focus()
          onSelect()
        }}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-2 text-left',
          onClose ? 'pr-12 md:pr-8 [@media(pointer:coarse)]:pr-12' : 'pr-2'
        )}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
      {onClose && (
        <span className="pointer-events-auto absolute right-1 top-1/2 z-critical flex -translate-y-1/2 items-center opacity-100 transition-opacity md:pointer-events-none md:opacity-0 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 hover:pointer-events-auto hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100">
          <button
            type="button"
            data-testid={`${testId}-close-button`}
            tabIndex={active ? 0 : -1}
            onClick={event => {
              event.stopPropagation()
              onClose()
            }}
            className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-text-primary/70 hover:text-background focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus md:h-6 md:w-6 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
            aria-label={t('workbench.close_right_workspace_panel')}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
    </div>
  )
}
