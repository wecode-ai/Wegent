import { CircleX, Target } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

interface ComposerModePillProps {
  label: string
  testId: string
  onCancel?: () => void
  cancelTestId?: string
  cancelLabel?: string
  onClick?: () => void
  role?: 'button' | 'switch'
  ariaChecked?: boolean
  disabled?: boolean
  className?: string
  title?: string
  icon?: LucideIcon
  mobile?: boolean
}

export function ComposerModePill({
  label,
  testId,
  onCancel,
  cancelTestId = 'cancel-mode-pill-button',
  cancelLabel,
  onClick,
  role,
  ariaChecked,
  disabled = false,
  className = '',
  title,
  icon: Icon,
  mobile = false,
}: ComposerModePillProps) {
  const { t } = useTranslation('common')
  const interactive = Boolean(onClick)
  const resolvedRole = role ?? (interactive ? 'button' : undefined)
  const resolvedCancelLabel = cancelLabel ?? t('workbench.cancel_mode', '取消模式')

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || disabled) return
    if (event.key !== 'Enter' && event.key !== ' ') return

    event.preventDefault()
    onClick?.()
  }

  return (
    <div
      data-testid={testId}
      role={resolvedRole}
      aria-checked={resolvedRole === 'switch' ? ariaChecked : undefined}
      aria-disabled={interactive ? disabled : undefined}
      tabIndex={interactive && !disabled ? 0 : undefined}
      onClick={() => {
        if (!disabled) onClick?.()
      }}
      onKeyDown={handleKeyDown}
      className={[
        `group relative flex w-fit shrink-0 items-center justify-center border border-border/70 bg-muted text-sm font-semibold leading-[18px] text-text-secondary transition-[background-color,color] hover:bg-muted/80 hover:text-text-primary ${mobile ? 'h-11 rounded-full px-3' : 'h-7 rounded-xl px-2.5'}`,
        interactive && !disabled ? 'cursor-pointer' : '',
        disabled ? 'cursor-not-allowed opacity-50' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      title={title}
    >
      {Icon && (
        <Icon
          data-testid={`${testId}-icon`}
          data-mode-icon
          className="mr-1.5 h-4 w-4 shrink-0 transition-opacity group-hover:opacity-0"
          aria-hidden="true"
        />
      )}
      {onCancel && (
        <button
          type="button"
          data-testid={cancelTestId}
          onClick={event => {
            event.stopPropagation()
            onCancel()
          }}
          disabled={disabled}
          className="pointer-events-none absolute left-2 flex h-5 w-5 items-center justify-center rounded-full bg-text-muted/15 text-text-muted opacity-0 transition-[opacity,background-color,color] group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-text-muted/30 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-0"
          aria-label={resolvedCancelLabel}
        >
          <CircleX className="h-4 w-4 shrink-0" />
        </button>
      )}
      <span data-mode-label>{label}</span>
    </div>
  )
}

interface GoalDraftPillProps {
  onCancel?: () => void
  className?: string
  mobile?: boolean
}

export function GoalDraftPill({ onCancel, className = '', mobile = false }: GoalDraftPillProps) {
  const { t } = useTranslation('common')

  return (
    <ComposerModePill
      label={t('workbench.goal_chip', '目标')}
      icon={Target}
      testId="goal-draft-pill"
      cancelTestId="cancel-goal-draft-button"
      cancelLabel={t('workbench.cancel_goal_draft', '取消目标')}
      onCancel={onCancel}
      className={className}
      mobile={mobile}
      title={t('workbench.confirm_goal', '明确目标')}
    />
  )
}
