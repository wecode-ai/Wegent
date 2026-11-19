import type { HTMLAttributes, ReactNode } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

export function SectionTitle({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 mt-7 flex items-center justify-between px-1 text-sm font-medium text-text-secondary">
      <h3>{title}</h3>
      {action && <span className="text-text-secondary">{action}</span>}
    </div>
  )
}

export function SettingsGroup({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/70',
        className
      )}
      {...props}
    />
  )
}

interface SettingsRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: ReactNode
  description?: ReactNode
  requiredLabel?: string
  error?: string
  labelClassName?: string
  children?: ReactNode
}

export function SettingsRow({
  label,
  description,
  requiredLabel,
  error,
  children,
  labelClassName,
  className,
  ...props
}: SettingsRowProps) {
  return (
    <div
      className={cn(
        'flex min-h-12 items-center justify-between gap-6 px-4 py-3 max-md:flex-col max-md:items-stretch max-md:gap-3',
        className
      )}
      {...props}
    >
      <div className="min-w-0 flex-1">
        <div className={cn('text-sm font-medium text-text-primary', labelClassName)}>
          {label}
          {requiredLabel && (
            <span
              className={cn('ml-1 font-normal', error ? 'text-destructive' : 'text-text-muted')}
            >
              ({requiredLabel})
            </span>
          )}
        </div>
        {description && (
          <div className="mt-0.5 text-xs leading-4 text-text-secondary">{description}</div>
        )}
        {error && (
          <div role="alert" className="mt-0.5 text-xs leading-4 text-destructive">
            {error}
          </div>
        )}
      </div>
      {children && (
        <div className="flex min-w-0 max-w-full shrink-0 items-center justify-end gap-2">
          {children}
        </div>
      )}
    </div>
  )
}
