export { SettingsGroup, SettingsRow } from '@wegent/collaboration/controls/SettingsLayout'
import type { HTMLAttributes, ReactNode } from 'react'

type SettingsPageWidth = 'standard' | 'narrow'

const PAGE_WIDTH_CLASS: Record<SettingsPageWidth, string> = {
  standard: 'max-w-3xl',
  narrow: 'max-w-[560px]',
}

interface SettingsPageProps extends HTMLAttributes<HTMLDivElement> {
  width?: SettingsPageWidth
}

export function SettingsPage({ width = 'standard', className = '', ...props }: SettingsPageProps) {
  return (
    <div
      className={`mx-auto w-full ${PAGE_WIDTH_CLASS[width]} pb-10 ${className}`.trim()}
      {...props}
    />
  )
}

interface SettingsPageHeaderProps {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}

export function SettingsPageHeader({
  title,
  description,
  actions,
  className = '',
}: SettingsPageHeaderProps) {
  return (
    <div
      className={`mb-8 flex items-start justify-between gap-4 max-sm:flex-col ${className}`.trim()}
    >
      <div className="min-w-0">
        <h1 className="heading-base tracking-normal text-text-primary">{title}</h1>
        {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export { SegmentedControl as SettingsSegmentedControl } from '@wegent/collaboration/controls/SegmentedControl'

export { Switch as SettingsSwitch } from '@wegent/collaboration/controls/Switch'
