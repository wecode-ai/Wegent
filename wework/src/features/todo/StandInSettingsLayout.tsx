import type { ReactNode } from 'react'
import { ArrowLeft, ChevronRight, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInSettingsHeader({
  title,
  description,
  disabled,
  back,
  close,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  disabled: boolean
  back?: { testId: string; onClick(): void }
  close?: { testId: string; onClick(): void }
  actions?: ReactNode
}) {
  const { t } = useTranslation('common')
  return (
    <header className="sticky top-0 z-10 mb-5 flex shrink-0 items-start gap-3 border-b border-border bg-background py-4">
      {back && (
        <button
          type="button"
          data-testid={back.testId}
          disabled={disabled}
          aria-label={t('standIn.personal.back')}
          onClick={back.onClick}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="heading-sm">{title}</h2>
        {description && <p className="mt-1 text-sm text-text-muted">{description}</p>}
      </div>
      {actions}
      {close && (
        <button
          type="button"
          data-testid={close.testId}
          disabled={disabled}
          aria-label={t('standIn.close')}
          onClick={close.onClick}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </header>
  )
}

export function StandInSettingsActions({
  prefix,
  disabled,
  saveDisabled,
  onCancel,
  onSave,
  saveLabel,
  children,
}: {
  prefix: string
  disabled: boolean
  saveDisabled: boolean
  onCancel(): void
  onSave(): void
  saveLabel?: string
  children?: ReactNode
}) {
  const { t } = useTranslation('common')
  return (
    <footer className="sticky bottom-0 z-10 mt-6 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background py-4">
      {children}
      <button
        type="button"
        data-testid={`${prefix}-cancel`}
        disabled={disabled}
        onClick={onCancel}
        className="min-h-9 rounded-lg px-3 text-sm hover:bg-muted"
      >
        {t('standIn.cancel')}
      </button>
      <button
        type="button"
        data-testid={`${prefix}-save`}
        disabled={saveDisabled}
        onClick={onSave}
        className="min-h-9 rounded-lg bg-text-primary px-4 text-sm text-background disabled:opacity-50"
      >
        {saveLabel ?? t('standIn.save')}
      </button>
    </footer>
  )
}

export function StandInReceiveWork({
  enabled,
  disabled,
  testId,
  pending,
  onChange,
}: {
  enabled: boolean
  disabled: boolean
  testId: string
  pending?: boolean
  onChange(enabled: boolean): void
}) {
  const { t } = useTranslation('common')
  return (
    <div className="space-y-2">
      <label className="flex min-h-9 items-center justify-between gap-3">
        <span>{t('standIn.workspace.receive_new')}</span>
        <input
          type="checkbox"
          role="switch"
          data-testid={testId}
          checked={enabled}
          aria-checked={enabled}
          disabled={disabled}
          onChange={event => onChange(event.target.checked)}
          className="h-4 w-4 accent-text-primary"
        />
      </label>
      <p
        className="text-xs text-text-muted"
        data-testid={pending ? 'stand-in-pending-save' : undefined}
      >
        {t('standIn.workspace.pause_help')}
      </p>
    </div>
  )
}

export function StandInConnectionEntry({
  testId,
  disabled,
  onClick,
}: {
  testId: string
  disabled: boolean
  onClick(): void
}) {
  const { t } = useTranslation('common')
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-11 w-full items-center gap-3 border-t border-border py-4 text-left disabled:opacity-40"
    >
      <span className="flex-1">
        <span className="block font-medium">{t('standIn.workspace.connections')}</span>
        <span className="mt-1 block text-sm text-text-muted">
          {t('standIn.workspace.connections_help')}
        </span>
      </span>
      <ChevronRight className="h-4 w-4" />
    </button>
  )
}
