import { Switch as UiSwitch } from '@ui-sdk/react/switch'
import type { LucideIcon } from 'lucide-react'
import { CircleX, Target } from 'lucide-react'
import type { CollaborationTranslate } from '../i18n'
import { Button as ControlButton } from '../markdown/Button'

export interface ComposerModePillProps {
  translate: CollaborationTranslate
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
}

export function ComposerModePill({
  translate: t,
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
}: ComposerModePillProps) {
  const interactive = Boolean(onClick)
  const resolvedCancelLabel =
    cancelLabel ?? t('workbench.cancel_mode', '取消模式')

  const content = (
    <>
      {Icon && (
        <Icon
          data-testid={testId + '-icon'}
          className={[
            'mr-1.5 h-4 w-4 shrink-0 transition-opacity group-hover:opacity-0',
            onCancel && 'hidden md:inline-flex',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </>
  )
  const actionClass =
    'flex min-h-11 min-w-8 max-w-full flex-1 items-center justify-center rounded-xl px-2.5 bg-transparent text-sm font-semibold text-inherit outline-none hover:bg-transparent disabled:cursor-not-allowed disabled:opacity-40 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 md:min-h-7 md:h-7'
  return (
    <div
      data-testid={interactive ? undefined : testId}
      className={[
        'group relative flex min-h-11 max-w-full shrink items-center rounded-xl border border-border/70 bg-muted text-text-secondary transition-colors hover:bg-muted/80 hover:text-text-primary md:min-h-7',
        className,
      ].join(' ')}
      title={title}
    >
      {interactive ? (
        role === 'switch' ? (
          <UiSwitch
            data-testid={testId}
            checked={Boolean(ariaChecked)}
            disabled={disabled}
            onCheckedChange={() => onClick?.()}
            aria-label={label}
            className={[actionClass, onCancel && 'pl-11 md:pl-2.5']
              .filter(Boolean)
              .join(' ')}
          >
            {content}
          </UiSwitch>
        ) : (
          <ControlButton
            variant="ghost"
            size="sm"
            type="button"
            data-testid={testId}
            disabled={disabled}
            onClick={onClick}
            className={[actionClass, onCancel && 'pl-11 md:pl-2.5']
              .filter(Boolean)
              .join(' ')}
          >
            {content}
          </ControlButton>
        )
      ) : (
        <span
          className={[actionClass, onCancel && 'pl-11 md:pl-2.5']
            .filter(Boolean)
            .join(' ')}
        >
          {content}
        </span>
      )}
      {onCancel && (
        <ControlButton
          variant="unstyled"
          size="icon"
          type="button"
          data-testid={cancelTestId}
          onClick={(event) => {
            event.stopPropagation()
            onCancel()
          }}
          disabled={disabled}
          className="pointer-events-auto absolute left-0 flex items-center justify-center rounded-xl bg-muted text-text-secondary opacity-100 transition-opacity md:pointer-events-none md:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 md:h-7 md:w-7"
          aria-label={resolvedCancelLabel}
        >
          <CircleX className="h-4 w-4" />
        </ControlButton>
      )}
    </div>
  )
}

export interface GoalDraftPillProps {
  translate: CollaborationTranslate
  onCancel?: () => void
  className?: string
}

export function GoalDraftPill({
  translate: t,
  onCancel,
  className = '',
}: GoalDraftPillProps) {
  return (
    <ComposerModePill
      translate={t}
      label={t('workbench.goal_chip', '目标')}
      icon={Target}
      testId="goal-draft-pill"
      cancelTestId="cancel-goal-draft-button"
      cancelLabel={t('workbench.cancel_goal_draft', '取消目标')}
      onCancel={onCancel}
      className={className}
      title={t('workbench.confirm_goal', '明确目标')}
    />
  )
}
