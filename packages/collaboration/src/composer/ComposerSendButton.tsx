import { ArrowUp, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { composerActionDensity, composerIconActionDensity } from '../controls/recipes'
import { Tooltip } from '../controls/Tooltip'
import { Button as ControlButton } from '../markdown/Button'

export const composerSendMenuClassName =
  'flex items-center justify-center rounded-none rounded-r-full border-l border-text-muted/40 text-inherit hover:bg-text-muted/15'

export function ComposerSendGroup({
  children,
  disabled,
  selected,
}: {
  children: ReactNode
  disabled?: boolean
  selected?: boolean
}) {
  const appearance = selected
    ? `bg-background ring-1 ring-inset ${disabled ? 'text-text-muted ring-border' : 'text-text-primary ring-text-primary'}`
    : `text-background ${disabled ? 'bg-text-muted/45' : 'bg-text-primary'}`
  return (
    <div
      data-composer-send-group="true"
      data-selected={selected || undefined}
      className={`flex shrink-0 items-center rounded-full ${appearance}`}
    >
      {children}
    </div>
  )
}

export function ComposerSendButton({
  label,
  text,
  disabled,
  testId,
  tooltipTestId,
  split = false,
  icon: Icon = ArrowUp,
}: {
  label: string
  text?: string
  disabled: boolean
  testId: string
  tooltipTestId?: string
  split?: boolean
  icon?: LucideIcon
}) {
  const appearance = split
    ? `${composerIconActionDensity} rounded-l-full text-inherit enabled:hover:bg-text-muted/15 disabled:opacity-100`
    : text
      ? `${composerActionDensity} rounded-lg px-3 text-sm font-medium`
      : `${composerIconActionDensity} rounded-full`
  const button = (
    <ControlButton
      variant="unstyled"
      type="submit"
      data-composer-primary-action="true"
      data-testid={testId}
      disabled={disabled}
      showTooltip={false}
      onMouseDown={event => event.preventDefault()}
      className={`${appearance} flex shrink-0 items-center justify-center gap-1.5 disabled:cursor-not-allowed ${split ? '' : 'bg-text-primary text-background disabled:bg-text-muted/45'}`}
      aria-label={label}
    >
      {text || <span className="sr-only">{label}</span>}
      <Icon className="h-4 w-4" aria-hidden="true" />
    </ControlButton>
  )
  return disabled ? (
    button
  ) : (
    <Tooltip label={label} align="end" testId={tooltipTestId}>
      {button}
    </Tooltip>
  )
}
