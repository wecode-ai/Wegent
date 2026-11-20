import { useTranslation } from '@/hooks/useTranslation'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ArrowLeft, ChevronRight, X } from 'lucide-react'
import type { ReactNode } from 'react'

export function StandInSettingsError({
  error,
  retry,
}: {
  error: string | null
  retry?: { testId: string; disabled?: boolean; onClick(): void }
}) {
  const { t } = useTranslation('common')
  if (!error) return null
  return (
    <div role="alert" className="text-sm text-error">
      <p>{error}</p>
      {retry && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid={retry.testId}
          disabled={retry.disabled}
          onClick={retry.onClick}
          className="mt-1 min-h-11 min-w-11 underline md:min-h-8"
        >
          {t('standIn.reload')}
        </ControlButton>
      )}
    </div>
  )
}

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
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid={back.testId}
          disabled={disabled}
          aria-label={t('standIn.personal.back')}
          onClick={back.onClick}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-muted md:h-8 md:w-8"
        >
          <ArrowLeft className="h-4 w-4" />
        </ControlButton>
      )}
      <div className="min-w-0 flex-1">
        {path && path.length > 1 && (
          <nav
            aria-label={t('standIn.workspace.settings_path')}
            data-testid="stand-in-settings-path"
            className="mb-1 flex flex-wrap items-center gap-1 text-xs text-text-secondary"
          >
            {path.map((entry, index) => (
              <span key={entry.testId} className="inline-flex items-center gap-1">
                {index > 0 && <ChevronRight aria-hidden="true" className="h-3 w-3" />}
                {entry.onClick ? (
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid={entry.testId}
                    disabled={disabled}
                    onClick={entry.onClick}
                    className="min-h-11 min-w-11 rounded px-1 hover:bg-muted hover:text-text-primary md:min-h-8 md:min-w-0"
                  >
                    {entry.label}
                  </ControlButton>
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
        {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
      </div>
      {actions}
      {close && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid={close.testId}
          disabled={disabled}
          aria-label={t('standIn.close')}
          onClick={close.onClick}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-muted md:h-8 md:w-8"
        >
          <X className="h-4 w-4" />
        </ControlButton>
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
  busy = false,
  children,
  leading,
}: {
  prefix: string
  disabled: boolean
  saveDisabled: boolean
  onCancel(): void
  onSave(): void
  saveLabel?: string
  busy?: boolean
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
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid={`${prefix}-cancel`}
        disabled={disabled}
        onClick={onCancel}
        className="min-h-11 rounded-lg px-3 text-sm hover:bg-muted md:min-h-9"
      >
        {t('standIn.cancel')}
      </ControlButton>
      <ControlButton
        variant="primary"
        size="sm"
        type="button"
        data-testid={`${prefix}-save`}
        aria-busy={busy || undefined}
        disabled={saveDisabled}
        onClick={onSave}
        className="min-h-11 rounded-lg bg-text-primary px-4 text-sm text-background disabled:opacity-50 md:min-h-9"
      >
        {saveLabel ?? t('standIn.save')}
      </ControlButton>
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
  const { t } = useTranslation('common')
  return (
    <ControlButton
      variant="outline"
      size="sm"
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-11 w-full items-center gap-3 rounded-lg border border-border bg-muted/30 p-3 text-left hover:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/70 disabled:opacity-40"
    >
      <span className="flex-1">
        <span className="block font-medium">{label}</span>
        {description && (
          <span className="mt-1 block text-sm text-text-secondary">{description}</span>
        )}
      </span>
      <span className="shrink-0 rounded-md border border-border bg-background px-2 py-1 text-sm">
        {t('standIn.personal.manage')}
      </span>
      <ChevronRight className="h-4 w-4" />
    </ControlButton>
  )
}
