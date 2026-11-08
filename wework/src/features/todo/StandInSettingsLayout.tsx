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
  path,
}: {
  title: ReactNode
  description?: ReactNode
  disabled: boolean
  back?: { testId: string; onClick(): void }
  close?: { testId: string; onClick(): void }
  actions?: ReactNode
  path?: Array<{ label: string; testId: string; onClick?: () => void }>
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
        {path && path.length > 1 && (
          <nav
            aria-label={t('standIn.workspace.settings_path')}
            data-testid="stand-in-settings-path"
            className="mb-1 flex flex-wrap items-center gap-1 text-xs text-text-muted"
          >
            {path.map((entry, index) => (
              <span key={entry.testId} className="inline-flex items-center gap-1">
                {index > 0 && <ChevronRight aria-hidden="true" className="h-3 w-3" />}
                {entry.onClick ? (
                  <button
                    type="button"
                    data-testid={entry.testId}
                    disabled={disabled}
                    onClick={entry.onClick}
                    className="min-h-8 rounded px-1 hover:bg-muted hover:text-text-primary"
                  >
                    {entry.label}
                  </button>
                ) : (
                  <span data-testid={entry.testId} aria-current="page">
                    {entry.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
        )}
        {title && (!path || path.length < 2) && (
          <h2 className="heading-sm flex min-h-8 items-center">{title}</h2>
        )}
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
  leading,
}: {
  prefix: string
  disabled: boolean
  saveDisabled: boolean
  onCancel(): void
  onSave(): void
  saveLabel?: string
  children?: ReactNode
  leading?: ReactNode
}) {
  const { t } = useTranslation('common')
  return (
    <footer className="sticky bottom-0 z-10 mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background py-4">
      {children}
      {leading && (
        <div data-testid={`${prefix}-footer-leading`} className="mr-auto flex items-center">
          {leading}
        </div>
      )}
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

export function StandInSettingsEntry({
  testId,
  disabled,
  onClick,
  label,
  description,
}: {
  testId: string
  disabled: boolean
  onClick(): void
  label: string
  description?: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-11 w-full items-center gap-3 border-t border-border py-4 text-left disabled:opacity-40"
    >
      <span className="flex-1">
        <span className="block font-medium">{label}</span>
        {description && <span className="mt-1 block text-sm text-text-muted">{description}</span>}
      </span>
      <ChevronRight className="h-4 w-4" />
    </button>
  )
}
