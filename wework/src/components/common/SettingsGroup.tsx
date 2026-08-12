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

export function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-6 py-2">
      <span className="shrink-0 text-sm font-medium">{label}</span>
      <span className="flex min-w-0 flex-1 items-center justify-end">{children}</span>
    </div>
  )
}
