import { LogIn, Plus } from 'lucide-react'
import type { CollaborationTranslate } from '../i18n'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

export function ModelSelectorEmptyState({
  translate: t,
  mobile = false,
  onOpenModelSettings,
  onOpenCloudConnections,
}: {
  translate: CollaborationTranslate
  mobile?: boolean
  onOpenModelSettings(): void
  onOpenCloudConnections?(): void
}) {
  return (
    <div
      data-testid="model-selector-empty-state"
      className={cn('space-y-3 px-3 py-4', mobile && 'rounded-2xl bg-surface px-4 py-5')}
    >
      <div className="space-y-1">
        <p className="text-sm font-medium text-text-primary">
          {t('workbench.no_models', 'No models available')}
        </p>
        <p className="text-xs leading-5 text-text-muted">
          {t(
            onOpenCloudConnections
              ? 'workbench.no_models_guidance'
              : 'workbench.no_models_guidance_connected',
            'Add a custom model, or sign in to Wegent to sync cloud models.'
          )}
        </p>
      </div>
      <div className={cn('space-y-1', mobile && 'space-y-2')}>
        <button
          type="button"
          data-testid="model-selector-add-custom-model"
          onClick={onOpenModelSettings}
          className={cn(
            'flex w-full items-center gap-2 text-left text-sm font-medium text-text-primary hover:bg-muted',
            mobile
              ? 'h-11 rounded-xl border border-border bg-background px-3'
              : 'h-8 rounded-lg px-2'
          )}
        >
          <Plus className="h-4 w-4 shrink-0 text-text-secondary" />
          {t('workbench.no_models_add_custom', 'Add custom model')}
        </button>
        {onOpenCloudConnections ? (
          <button
            type="button"
            data-testid="model-selector-login-cloud"
            onClick={onOpenCloudConnections}
            className={cn(
              'flex w-full items-center gap-2 text-left text-sm font-medium',
              mobile
                ? 'h-11 rounded-xl bg-text-primary px-3 text-background'
                : 'h-8 rounded-lg px-2 text-text-primary hover:bg-muted'
            )}
          >
            <LogIn
              className={cn('h-4 w-4 shrink-0', mobile ? 'text-background' : 'text-text-secondary')}
            />
            {t('workbench.no_models_login_cloud', 'Sign in and sync cloud models')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
