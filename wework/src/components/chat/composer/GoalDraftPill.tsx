import { CircleX } from 'lucide-react'
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
        'group flex h-7 w-fit shrink-0 items-center justify-center rounded-xl border border-border/70 bg-muted px-2.5 text-[13px] font-semibold leading-[18px] text-text-secondary transition-[background-color,color] hover:bg-muted/80 hover:text-text-primary',
        interactive && !disabled ? 'cursor-pointer' : '',
        disabled ? 'cursor-not-allowed opacity-50' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      title={title}
    >
      {onCancel && (
        <button
          type="button"
          data-testid={cancelTestId}
          onClick={event => {
            event.stopPropagation()
            onCancel()
          }}
          disabled={disabled}
          className="pointer-events-none flex h-5 w-0 items-center justify-center overflow-hidden rounded-full bg-text-muted/15 text-text-muted opacity-0 transition-[width,margin,opacity,background-color,color] group-hover:pointer-events-auto group-hover:mr-1.5 group-hover:w-5 group-hover:bg-text-muted/15 group-hover:opacity-100 hover:bg-text-muted/30 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-0"
          aria-label={resolvedCancelLabel}
        >
          <CircleX className="h-4 w-4 shrink-0" />
        </button>
      )}
      <span>{label}</span>
    </div>
  )
}

interface GoalDraftPillProps {
  onCancel?: () => void
  className?: string
}

export function GoalDraftPill({ onCancel, className = '' }: GoalDraftPillProps) {
  const { t } = useTranslation('common')

  return (
    <ComposerModePill
      label={t('workbench.goal_chip', '目标')}
      testId="goal-draft-pill"
      cancelTestId="cancel-goal-draft-button"
      cancelLabel={t('workbench.cancel_goal_draft', '取消目标')}
      onCancel={onCancel}
      className={className}
      title={t('workbench.confirm_goal', '明确目标')}
    />
  )
}
