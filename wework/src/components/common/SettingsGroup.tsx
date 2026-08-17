import type { ReactNode } from 'react'

export function SectionTitle({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-2 mt-7 flex items-center justify-between px-1 text-sm font-medium text-text-tertiary">
      <h3>{title}</h3>
      {action ? <span className="text-text-secondary">{action}</span> : null}
    </div>
  )
}

export function SettingsGroup({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border px-4">
      {children}
    </div>
  )
}

export function SettingsRow({
  label,
  description,
  requiredLabel,
  error,
  children,
}: {
  label: string
  description?: string
  requiredLabel?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-6 py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">
          {label}
          {requiredLabel ? (
            <span className={`ml-1 font-normal ${error ? 'text-destructive' : 'text-text-muted'}`}>
              ({requiredLabel})
            </span>
          ) : null}
        </span>
        {description ? (
          <span className="mt-0.5 block text-xs leading-4 text-text-secondary">{description}</span>
        ) : null}
        {error ? (
          <span className="mt-0.5 block text-xs leading-4 text-destructive">{error}</span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 items-center justify-end">{children}</span>
    </div>
  )
}
