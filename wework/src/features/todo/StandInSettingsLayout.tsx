import { useTranslation } from '@/hooks/useTranslation'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ArrowLeft, ChevronRight, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useId } from 'react'

export function StandInSettingsPanel({
  testId,
  contentTestId,
  onClose,
  active,
  suspended,
  embedded = false,
  calendarOpen,
  children,
}: {
  testId: string
  contentTestId?: string
  onClose(): void
  active?: boolean
  suspended?: boolean
  embedded?: boolean
  calendarOpen: boolean
  children: ReactNode
}) {
  return (
    <DialogSurface
      onClose={onClose}
      active={active}
      suspended={suspended}
      render={
        <section
          className={`min-h-0 px-5 text-base text-text-primary ${embedded ? '' : 'h-full'} ${calendarOpen ? 'overflow-hidden' : 'overflow-y-auto'}`}
          data-testid={testId}
        />
      }
    >
      <div
        className={`flex w-full flex-col ${calendarOpen ? 'h-full min-h-0' : 'min-h-full'}`}
        data-testid={contentTestId}
      >
        {children}
      </div>
    </DialogSurface>
  )
}

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
  path,
}: {
  title: ReactNode
  description?: ReactNode
  disabled: boolean
  back?: { testId: string; onClick(): void }
  close?: { testId: string; onClick(): void }
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
                  <span
                    data-testid={entry.testId}
                    aria-current={index === path.length - 1 ? 'page' : undefined}
                    role={index === path.length - 1 ? 'heading' : undefined}
                    aria-level={index === path.length - 1 ? 2 : undefined}
                    className={
                      index === path.length - 1 ? 'font-medium text-text-primary' : undefined
                    }
                  >
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
        <div
          data-testid={`${prefix}-footer-leading`}
          className="mr-auto flex max-w-full flex-wrap items-center gap-2"
        >
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
  summary,
  footer,
  grouped = false,
}: {
  testId: string
  disabled: boolean
  onClick(): void
  label: string
  description?: string
  summary?: ReactNode
  footer?: ReactNode
  grouped?: boolean
}) {
  const labelId = useId()
  const descriptionId = useId()
  return (
    <div className={grouped ? undefined : 'rounded-lg border border-border'}>
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid={testId}
        disabled={disabled}
        onClick={onClick}
        aria-labelledby={labelId}
        aria-describedby={description || summary ? descriptionId : undefined}
        className="flex min-h-11 w-full items-center gap-3 rounded-lg p-3 text-left text-sm hover:bg-muted"
      >
        <span className="min-w-0 flex-1 whitespace-normal break-words">
          <span id={labelId} className="block font-medium">
            {label}
          </span>
          {(description || summary) && (
            <span id={descriptionId} className="mt-1 block text-sm text-text-secondary">
              {description && <span className="block">{description}</span>}
              {summary}
            </span>
          )}
        </span>
        <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
      </ControlButton>
      {footer && <div className="mx-3 border-t border-border py-1">{footer}</div>}
    </div>
  )
}

export type StandInSettingsShortcut = {
  id: 'im' | 'revision' | 'memory'
  testId: string
  containerTestId?: string
  label: string
  description?: string
} & ({ content: ReactNode; onClick?: never } | { content?: never; onClick(): void })

export function StandInSettingsShortcuts({
  shortcuts,
  disabled,
  onOpen,
}: {
  shortcuts?: StandInSettingsShortcut[]
  disabled: boolean
  onOpen(id: StandInSettingsShortcut['id']): void
}) {
  const entries = shortcuts?.filter(shortcut => shortcut.id !== 'revision')
  if (!entries?.length) return null
  return (
    <section data-testid="stand-in-settings-tools" className="mt-4 space-y-4">
      {entries.map(({ id, testId, containerTestId, label, description, onClick }) => (
        <div key={id} data-testid={containerTestId}>
          <StandInSettingsEntry
            testId={testId}
            label={label}
            description={description}
            disabled={disabled}
            onClick={onClick ?? (() => onOpen(id))}
          />
        </div>
      ))}
    </section>
  )
}
