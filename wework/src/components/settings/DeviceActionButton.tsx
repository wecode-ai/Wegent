import type { ComponentType } from 'react'

export function DeviceActionButton({
  testId,
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  testId: string
  icon: ComponentType<{ className?: string }>
  label: string
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
    </button>
  )
}
