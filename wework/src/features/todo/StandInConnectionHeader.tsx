import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export function StandInConnectionHeader({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon
  title: string
  description?: string
  children?: ReactNode
}) {
  return (
    <header className="shrink-0 space-y-2" data-testid="stand-in-connection-header">
      <h3 className="flex items-center gap-2 text-base font-medium">
        <Icon aria-hidden="true" className="h-4 w-4" />
        {title}
      </h3>
      {children}
      {description && <p className="text-sm text-text-secondary">{description}</p>}
    </header>
  )
}
