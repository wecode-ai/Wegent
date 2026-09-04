import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import { DshIcon } from './DshIcon'
import { executeDshCommand } from './dshExtensions'
import { useDshMenuCommands } from './useDshMenuCommands'

interface DshMenuActionsProps {
  buttonClassName?: string
  className?: string
  location: string
  showLabels?: boolean
}

export function DshMenuActions({
  buttonClassName,
  className,
  location,
  showLabels = false,
}: DshMenuActionsProps) {
  const actions = useDshMenuCommands(location)

  if (actions.length === 0) return null

  return (
    <div className={cn('contents', className)}>
      {actions.map(action => {
        const button = (
          <button
            key={action.id}
            type="button"
            data-testid={`wework-menu-action-${action.id}`}
            disabled={!action.enabled}
            className={cn(
              'flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-lg px-1.5 text-sm text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40',
              buttonClassName
            )}
            aria-label={action.title}
            onClick={() => {
              void executeDshCommand(action.command, undefined, {
                menuId: action.id,
                menuLocation: location,
                source: 'menu',
              }).catch(error => {
                console.error(`[Wework] Failed to execute menu command "${action.command}":`, error)
              })
            }}
          >
            <DshIcon name={action.icon} className="h-4 w-4" />
            {showLabels ? <span>{action.title}</span> : null}
          </button>
        )
        if (showLabels) return button
        return (
          <Tooltip
            key={action.id}
            label={action.title}
            testId={`wework-menu-action-${action.id}-tooltip`}
          >
            {button}
          </Tooltip>
        )
      })}
    </div>
  )
}
