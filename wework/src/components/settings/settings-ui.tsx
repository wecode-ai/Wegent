import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

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
        <h1 className="text-xl font-semibold tracking-normal text-text-primary">{title}</h1>
        {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function SettingsGroup({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex flex-col overflow-hidden rounded-2xl border border-border bg-surface/70 [&>*:not(:last-child)]:relative [&>*:not(:last-child)]:after:pointer-events-none [&>*:not(:last-child)]:after:absolute [&>*:not(:last-child)]:after:inset-x-4 [&>*:not(:last-child)]:after:bottom-0 [&>*:not(:last-child)]:after:h-px [&>*:not(:last-child)]:after:bg-border [&>*:not(:last-child)]:after:content-[''] ${className}`.trim()}
      {...props}
    />
  )
}

interface SettingsRowProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode
  description?: ReactNode
  control?: ReactNode
  labelClassName?: string
}

export function SettingsRow({
  label,
  description,
  control,
  labelClassName = '',
  className = '',
  ...props
}: SettingsRowProps) {
  return (
    <div
      className={`flex items-center justify-between gap-6 px-4 py-3 max-sm:flex-col max-sm:items-stretch max-sm:gap-3 ${className}`.trim()}
      {...props}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className={`min-w-0 text-sm font-medium text-text-primary ${labelClassName}`.trim()}>
          {label}
        </div>
        {description && (
          <div className="min-w-0 text-xs leading-4 text-text-secondary">{description}</div>
        )}
      </div>
      {control && (
        <div className="flex max-w-full shrink-0 items-center gap-2 max-sm:justify-end">
          {control}
        </div>
      )}
    </div>
  )
}

interface SettingsSwitchProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-checked' | 'onChange' | 'onClick' | 'role'
> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

export function SettingsSwitch({
  checked,
  onCheckedChange,
  className = '',
  disabled,
  ...props
}: SettingsSwitchProps) {
  const state = checked ? 'checked' : 'unchecked'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={state}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`inline-flex items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60 ${className}`.trim()}
      {...props}
    >
      <span
        data-state={state}
        className={`relative inline-flex h-5 w-8 shrink-0 items-center overflow-hidden rounded-full transition-colors ${
          checked ? 'bg-blue-500' : 'bg-text-muted/30'
        }`}
      >
        <span
          data-state={state}
          className={`block h-4 w-4 rounded-full border border-white bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-[14px]' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  )
}
