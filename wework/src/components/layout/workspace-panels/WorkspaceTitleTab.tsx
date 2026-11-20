import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { TabsTab } from '@wegent/collaboration/controls/Tabs'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

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
  value,
  closeTestId,
  closeLabel,
}: {
  testId?: string
  active: boolean
  label: string
  title?: string
  icon: ReactNode
  onSelect(): void
  onClose?(): void
  id?: string
  controls?: string
  value?: string
  closeTestId?: string
  closeLabel?: string
}) {
  const { t } = useTranslation('common')
  return (
    <TabsTab
      value={value ?? id ?? testId ?? label}
      render={<div />}
      id={id}
      data-testid={testId}
      aria-controls={controls}
      title={title}
      className={cn(
        'border-b-0 px-0 md:min-h-7 group/tab relative flex h-11 min-w-0 max-w-[200px] shrink-0 cursor-pointer items-stretch rounded-md text-left text-xs font-medium transition-colors focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus pointer-events-auto md:h-8 [@media(pointer:coarse)]:h-11',
        active
          ? 'bg-muted text-text-primary'
          : 'text-text-secondary hover:bg-muted hover:text-text-primary'
      )}
      onClick={() => {
        if (active) onSelect()
      }}
    >
      <ControlButton
        variant="ghost"
        size="sm"
        type="button"
        tabIndex={-1}
        data-testid={testId ? `${testId}-select-button` : undefined}
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
      </ControlButton>
      {onClose && (
        <span className="pointer-events-auto absolute right-1 top-1/2 z-critical flex -translate-y-1/2 items-center opacity-100 transition-opacity md:pointer-events-none md:opacity-0 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 hover:pointer-events-auto hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100">
          <ControlButton
            variant="ghost"
            size="icon"
            type="button"
            data-testid={closeTestId ?? (testId ? `${testId}-close-button` : undefined)}
            tabIndex={active ? 0 : -1}
            onClick={event => {
              event.stopPropagation()
              onClose()
            }}
            className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-text-primary/70 hover:text-background focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus md:h-6 md:w-6 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
            aria-label={closeLabel ?? t('workbench.close_right_workspace_panel')}
          >
            <X className="h-3 w-3" />
          </ControlButton>
        </span>
      )}
    </TabsTab>
  )
}
