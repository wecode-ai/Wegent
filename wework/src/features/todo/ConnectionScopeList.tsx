import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@wegent/collaboration/markdown/Button'
import { ChevronRight, Plus } from 'lucide-react'
import type { ReactNode, Ref } from 'react'

export function ConnectionScopeList({
  children,
  disabled,
  empty,
  onAdd,
  testId,
}: {
  children?: ReactNode
  disabled?: boolean
  empty?: string
  onAdd(): void
  testId: string
}) {
  const { t } = useTranslation('common')
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{t('standIn.workspace.connection_scope')}</h4>
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={disabled}
          onClick={onAdd}
          data-testid={testId}
        >
          <Plus className="size-4" aria-hidden />
          {t('standIn.workspace.connection_add_scope')}
        </Button>
      </div>
      {empty ? (
        <p className="text-sm text-text-secondary">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">{children}</ul>
      )}
    </section>
  )
}

export function ConnectionScopeRow({
  name,
  description,
  testId,
  disabled,
  direct = false,
  pending = false,
  onClick,
  onRemove,
  ref,
}: {
  name: string
  description?: string
  testId: string
  disabled?: boolean
  direct?: boolean
  pending?: boolean
  onClick(): void
  onRemove?(): void
  ref?: Ref<HTMLButtonElement>
}) {
  const { t } = useTranslation('common')
  return (
    <li className="flex items-center gap-1">
      <Button
        variant="unstyled"
        type="button"
        className="flex min-h-11 w-full min-w-0 justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted/60"
        data-testid={testId}
        ref={ref}
        disabled={disabled}
        onClick={onClick}
      >
        <span className="min-w-0 flex-1 whitespace-normal break-words">
          {name}
          {(description || pending) && (
            <span className="mt-0.5 block text-xs text-text-secondary">
              {description}
              {description && pending && ' · '}
              {pending && t('standIn.workspace.connection_pending_sources')}
            </span>
          )}
        </span>
        {!direct && <ChevronRight className="size-4 shrink-0 text-text-secondary" aria-hidden />}
      </Button>
      {onRemove && (
        <Button
          variant="unstyled"
          type="button"
          className="min-h-11 shrink-0 rounded-md px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary md:min-h-8"
          data-testid={`${testId}-remove`}
          aria-label={t('standIn.workspace.connection_remove_named_scope', { name })}
          disabled={disabled}
          onClick={onRemove}
        >
          {t('standIn.workspace.connection_remove_scope_action')}
        </Button>
      )}
    </li>
  )
}

export function PendingScopeRemoval({
  name,
  testId,
  disabled,
  onRestore,
}: {
  name: string
  testId: string
  disabled?: boolean
  onRestore(): void
}) {
  const { t } = useTranslation('common')
  return (
    <li
      className="flex min-h-11 items-center gap-3 px-3 py-2"
      data-testid={`${testId}-pending-removal`}
    >
      <span className="min-w-0 flex-1 break-words text-sm">
        {name}
        <span className="mt-0.5 block text-xs text-text-secondary">
          {t('standIn.workspace.connection_pending_removal')}
        </span>
      </span>
      <Button
        variant="unstyled"
        type="button"
        className="min-h-11 shrink-0 rounded-md px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary md:min-h-8"
        data-testid={`${testId}-undo-remove`}
        disabled={disabled}
        aria-label={t('standIn.workspace.connection_undo_named_removal', { name })}
        onClick={onRestore}
      >
        {t('standIn.workspace.connection_undo_removal')}
      </Button>
    </li>
  )
}
