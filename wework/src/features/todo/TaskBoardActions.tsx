import { Plus } from 'lucide-react'
import type { Ref } from 'react'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface TaskBoardCreateButtonProps {
  label: string
  onClick: () => void
  buttonRef?: Ref<HTMLButtonElement>
  showLabel?: boolean
  compact?: boolean
}

export function TaskBoardCreateButton({
  label,
  onClick,
  buttonRef,
  showLabel = false,
  compact = true,
}: TaskBoardCreateButtonProps) {
  return (
    <Tooltip label={label} side="bottom" align="end">
      <button
        ref={buttonRef}
        type="button"
        data-testid="cloud-todo-add"
        aria-label={label}
        onClick={onClick}
        className={cn(
          'electron-titlebar-interactive-region relative z-10 ml-2 flex h-8 items-center rounded-lg bg-text-primary text-background transition hover:opacity-90',
          compact ? 'w-8 justify-center' : 'gap-1.5 whitespace-nowrap px-3 text-sm font-medium'
        )}
      >
        <Plus className="h-3.5 w-3.5" />
        {showLabel ? label : null}
      </button>
    </Tooltip>
  )
}

export function TaskBoardColumnCreateButton({
  columnKey,
  label,
  onClick,
}: {
  columnKey: string
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip label={label} side="bottom" align="end">
      <button
        type="button"
        data-testid={`cloud-todo-column-add-${columnKey}`}
        onClick={onClick}
        className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-background hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 group-hover:opacity-100"
        aria-label={label}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  )
}
