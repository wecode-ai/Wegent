import { createAsyncResource, getIdleResourceSnapshot } from '@wegent/chat-core/async-resource'
import { Ellipsis, Loader2, Store } from 'lucide-react'
import { useMemo, useState, useSyncExternalStore } from 'react'
import type { ConfiguredCodexMarketplace, LocalCodexPluginApi } from '@/api/local/codexPlugins'
import { ActionMenu } from '@/components/common/ActionMenu'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { getErrorMessage } from '@/lib/error-message'

export function PluginMarketplaceManagement({
  api,
  checkingMarketplaces,
  onCheck,
  onSourcesLoaded,
  onRemoved,
  onReconcile,
}: {
  api: LocalCodexPluginApi
  checkingMarketplaces: ReadonlySet<string>
  onCheck: (marketplace: ConfiguredCodexMarketplace) => Promise<boolean>
  onSourcesLoaded: (marketplaces: ConfiguredCodexMarketplace[]) => void
  onRemoved: (marketplace: ConfiguredCodexMarketplace) => void
  onReconcile: () => void
}) {
  const { t } = useTranslation('common')
  const resource = useMemo(
    () =>
      createAsyncResource(
        'configured-plugin-marketplaces',
        () => api.listConfiguredMarketplaces(),
        {
          success: onSourcesLoaded,
        }
      ),
    [api, onSourcesLoaded]
  )
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const [confirmation, setConfirmation] = useState<ConfiguredCodexMarketplace | null>(null)
  const [removing, setRemoving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const marketplaces = snapshot.data ?? []
  const inventoryUnavailable = marketplaces.some(marketplace => marketplace.installed === null)
  const error =
    failure ??
    (snapshot.status === 'error'
      ? getErrorMessage(snapshot.error, t('workbench.plugins_marketplace_sources_load_failed'))
      : null)

  const remove = async (marketplace: ConfiguredCodexMarketplace) => {
    if (marketplace.installed === null) return
    setRemoving(true)
    setFailure(null)
    try {
      const ids = marketplace.installed.map(plugin => plugin.id)
      await api.deleteMarketplace(marketplace.id, marketplace.sourceRevision, ids)
      resource.update(items => items?.filter(item => item.id !== marketplace.id))
      onRemoved(marketplace)
    } catch (reason) {
      setFailure(getErrorMessage(reason, t('workbench.plugins_marketplace_removal_failed')))
      void resource.reload()
      onReconcile()
    } finally {
      setRemoving(false)
      setConfirmation(null)
    }
  }

  return (
    <section
      id="plugin-management-marketplaces-panel"
      role="tabpanel"
      aria-labelledby="plugin-management-marketplaces-tab"
      data-testid="plugin-management-marketplaces-panel"
    >
      {(error || inventoryUnavailable) && (
        <div
          className="mb-3 flex flex-wrap items-center gap-2 text-sm text-destructive"
          role="alert"
        >
          <span>{error ?? t('workbench.plugins_marketplace_inventories_unavailable')}</span>
          {(snapshot.status === 'error' ||
            (snapshot.status === 'ready' && inventoryUnavailable)) && (
            <button
              type="button"
              data-testid="plugin-marketplace-management-retry"
              className="min-h-11 rounded-md border border-border px-3 hover:bg-muted md:min-h-8"
              onClick={() => void resource.reload()}
            >
              {t('common.retry', '重试')}
            </button>
          )}
        </div>
      )}
      {!snapshot.settled && (
        <p className="text-sm text-text-secondary">{t('workbench.plugins_loading_marketplace')}</p>
      )}
      {snapshot.status === 'ready' && marketplaces.length === 0 && (
        <p className="rounded-xl border border-border/40 p-4 text-sm text-text-secondary">
          {t('workbench.plugins_marketplace_sources_empty')}
        </p>
      )}
      {marketplaces.length > 0 && (
        <div className="rounded-xl border border-border/40 bg-background">
          {marketplaces.map(marketplace => (
            <article
              key={marketplace.id}
              className="flex min-h-[72px] items-center gap-3 border-b border-border/30 px-4 py-3 last:border-b-0"
              data-testid={'plugin-marketplace-management-row-' + marketplace.id}
            >
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-border/40 bg-surface text-text-secondary">
                <Store className="h-4 w-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="break-words font-medium text-text-primary">{marketplace.name}</h2>
                <p className="mt-0.5 text-sm text-text-secondary">
                  {marketplace.sourceType === 'git'
                    ? ['Git', marketplace.gitRef].filter(Boolean).join(' · ')
                    : t('workbench.plugins_marketplace_local_source')}
                  {' · '}
                  {marketplace.installed === null
                    ? t('workbench.plugins_marketplace_inventory_unavailable')
                    : t('workbench.plugins_marketplace_installed_count', {
                        count: marketplace.installed.length,
                      })}
                </p>
              </div>
              {marketplace.sourceType === 'git' && (
                <button
                  type="button"
                  data-testid={'plugin-marketplace-management-check-' + marketplace.id}
                  className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2 text-sm hover:bg-muted disabled:opacity-50 md:min-h-8"
                  disabled={
                    removing ||
                    snapshot.status !== 'ready' ||
                    marketplace.installed === null ||
                    checkingMarketplaces.has(marketplace.id)
                  }
                  onClick={() => {
                    void onCheck(marketplace).then(reload => {
                      if (reload) void resource.reload()
                    })
                  }}
                >
                  {checkingMarketplaces.has(marketplace.id) && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  )}
                  {t('workbench.plugins_marketplace_check_updates')}
                </button>
              )}
              <ActionMenu
                testId={'plugin-marketplace-management-menu-' + marketplace.id}
                ariaLabel={t('workbench.plugins_marketplace_actions', { name: marketplace.name })}
                icon={Ellipsis}
                disabled={
                  removing ||
                  snapshot.status !== 'ready' ||
                  marketplace.installed === null ||
                  checkingMarketplaces.has(marketplace.id)
                }
                items={[
                  {
                    testId: 'plugin-marketplace-management-remove-' + marketplace.id,
                    label: t('workbench.plugins_marketplace_remove'),
                    danger: true,
                    onSelect: () => setConfirmation(marketplace),
                  },
                ]}
              />
            </article>
          ))}
        </div>
      )}
      {confirmation?.installed && (
        <ConfirmDialog
          open
          title={t('workbench.plugins_marketplace_remove_title')}
          description={
            <>
              {t('workbench.plugins_marketplace_remove_description', { name: confirmation.name })}
              {confirmation.installed.length > 0 && (
                <span className="mt-2 block">
                  {t('workbench.plugins_marketplace_remove_affected', {
                    count: confirmation.installed.length,
                  })}
                  <span className="mt-2 block rounded-lg bg-muted p-2">
                    {confirmation.installed.map(plugin => (
                      <span
                        key={plugin.id}
                        className="block break-words font-medium text-text-primary"
                      >
                        {plugin.name}
                        {plugin.version ? ' · v' + plugin.version : null}
                      </span>
                    ))}
                  </span>
                </span>
              )}
            </>
          }
          cancelLabel={t('common.cancel', '取消')}
          confirmLabel={t(
            confirmation.installed.length
              ? 'workbench.plugins_marketplace_uninstall_and_remove'
              : 'workbench.plugins_marketplace_remove'
          )}
          confirmTestId="plugin-marketplace-management-remove-confirm"
          dialogTestId="plugin-marketplace-management-remove-dialog"
          destructive
          pending={removing}
          onClose={() => setConfirmation(null)}
          onConfirm={() => void remove(confirmation)}
        />
      )}
    </section>
  )
}
