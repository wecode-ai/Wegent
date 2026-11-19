import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from '../markdown/Button'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { controlIconActionDensity } from './recipes'

export function ParticipantField({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      data-participant-field
      className={cn(
        'flex min-h-11 min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background p-1 md:min-h-9',
        className
      )}
    >
      {children}
    </div>
  )
}

export function ParticipantToken({
  icon,
  label,
  description,
  title,
  removeLabel,
  removeTestId,
  disabled,
  onRemove,
}: {
  icon: ReactNode
  label: string
  description?: string
  title?: string
  removeLabel?: string
  removeTestId?: string
  disabled?: boolean
  onRemove?(): void
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-md bg-muted pl-2 text-sm text-text-primary md:min-h-7 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-text-secondary',
        !onRemove && 'pr-2'
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      {description && <span className="shrink-0 text-text-secondary">{description}</span>}
      {onRemove && (
        <Button
          variant="unstyled"
          type="button"
          className={cn(
            controlIconActionDensity.dense,
            'flex shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-background hover:text-text-primary'
          )}
          aria-label={removeLabel}
          data-testid={removeTestId}
          disabled={disabled}
          onClick={onRemove}
        >
          <X aria-hidden="true" className="size-3" />
        </Button>
      )}
    </span>
  )
}
