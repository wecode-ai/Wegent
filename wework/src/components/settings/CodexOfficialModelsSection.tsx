import { AlertCircle, ChevronDown, Loader2, Pencil, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import {
  deleteLocalCodexModelCatalogOverride,
  getLocalCodexModelCatalogOverrides,
  saveLocalCodexModelCatalogOverride,
  type CodexModelCatalogOverride,
} from '@/api/local/codexOfficialModels'

import type {
  CodexOfficialModel,
  CodexOfficialModelList,
} from '@/features/model-settings/codexOfficialModels'

import { type LocalModelCatalogEntry } from '@/features/model-settings/localModelCatalog'

import { useTranslation } from '@/hooks/useTranslation'

import { requestLocalExecutor } from '@/desktop/localExecutor'

import { CustomModelCapabilitiesForm } from './CustomModelCapabilitiesForm'

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}
function LocalModelDiscardChangesDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('common')
  return (
    <ConfirmDialog
      open
      title={t('workbench.local_model_discard_changes_title')}
      description={t('workbench.local_model_discard_changes_description')}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('workbench.local_model_discard_changes_confirm')}
      confirmTestId="local-model-discard-changes-confirm-button"
      onClose={onCancel}
      onConfirm={onConfirm}
    />
  )
}
function LocalModelCatalogRestartDialog({
  restarting,
  onLater,
  onRestart,
}: {
  restarting: boolean
  onLater: () => void
  onRestart: () => void
}) {
  const { t } = useTranslation('common')

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-model-catalog-restart-title"
        data-testid="local-model-catalog-restart-dialog"
        className="w-full max-w-[420px] rounded-lg border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
      >
        <h2
          id="local-model-catalog-restart-title"
          className="text-sm font-semibold text-text-primary"
        >
          {t('workbench.local_model_catalog_restart_title')}
        </h2>
        <p className="mt-2 text-xs leading-5 text-text-secondary">
          {t('workbench.local_model_catalog_restart_description')}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="local-model-catalog-restart-later-button"
            onClick={onLater}
            disabled={restarting}
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
          >
            {t('workbench.local_model_catalog_restart_later')}
          </button>
          <button
            type="button"
            data-testid="local-model-catalog-restart-now-button"
            onClick={onRestart}
            disabled={restarting}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {restarting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('workbench.local_model_catalog_restart_now')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function CodexCatalogEditorDialog({
  model,
  catalog,
  saving,
  error,
  onClose,
  onSave,
}: {
  model: { modelId: string; providerName: string }
  catalog: CodexModelCatalogOverride
  saving: boolean
  error: string | null
  onClose: () => void
  onSave: (entry: LocalModelCatalogEntry) => void
}) {
  const { t } = useTranslation('common')
  const [entry, setEntry] = useState<LocalModelCatalogEntry>(() => catalog.effective)
  const [contextWindow, setContextWindow] = useState(() =>
    typeof catalog.effective.context_window === 'number'
      ? String(catalog.effective.context_window)
      : ''
  )
  const [discardConfirmation, setDiscardConfirmation] = useState(false)
  const initialEntry = JSON.stringify(catalog.effective)
  const dirty = JSON.stringify(entry) !== initialEntry
  const requestClose = () => {
    if (dirty) {
      setDiscardConfirmation(true)
      return
    }
    onClose()
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4 py-8">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="codex-catalog-editor-title"
          data-testid="codex-catalog-editor-dialog"
          className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
        >
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <h2
                id="codex-catalog-editor-title"
                className="truncate text-base font-semibold text-text-primary"
              >
                {t('workbench.codex_catalog_editor_title', { model: model.modelId })}
              </h2>
              <p className="mt-1 text-xs text-text-secondary">
                {t('workbench.codex_catalog_editor_identity', {
                  provider: model.providerName,
                  slug: catalog.slug,
                })}
              </p>
            </div>
            <button
              type="button"
              data-testid="codex-catalog-editor-close"
              onClick={requestClose}
              disabled={saving}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
              aria-label={t('common.close', '关闭')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <CustomModelCapabilitiesForm
              entry={entry}
              contextWindow={contextWindow}
              onContextWindowChange={value => {
                setContextWindow(value)
                const parsed = Number(value)
                setEntry(current => ({
                  ...current,
                  context_window: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
                  max_context_window: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
                }))
              }}
              onChange={setEntry}
            />
            {error && (
              <div
                data-testid="codex-catalog-editor-error"
                className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
            <button
              type="button"
              data-testid="codex-catalog-editor-cancel"
              onClick={requestClose}
              disabled={saving}
              className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
            >
              {t('common.cancel', '取消')}
            </button>
            <button
              type="button"
              data-testid="codex-catalog-editor-save"
              onClick={() => onSave(entry)}
              disabled={saving || !dirty}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('common.save', '保存')}
            </button>
          </div>
        </div>
      </div>
      {discardConfirmation && (
        <LocalModelDiscardChangesDialog
          onCancel={() => setDiscardConfirmation(false)}
          onConfirm={onClose}
        />
      )}
    </>,
    document.body
  )
}

export function CodexOfficialModelsSection({
  modelList,
  loading,
  error,
  onRefresh,
}: {
  modelList: CodexOfficialModelList | null
  loading: boolean
  error: string | null
  onRefresh: () => void | Promise<void>
}) {
  const { t } = useTranslation('common')
  const models = useMemo(() => modelList?.models ?? [], [modelList])
  const providers = useMemo(() => modelList?.providers ?? [], [modelList])
  const [expandedProviderIds, setExpandedProviderIds] = useState<Set<string>>(() => new Set())
  const [catalogModels, setCatalogModels] = useState<Map<string, CodexModelCatalogOverride>>(
    () => new Map()
  )
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [editingCatalog, setEditingCatalog] = useState<{
    model: CodexOfficialModel
    catalog: CodexModelCatalogOverride
  } | null>(null)
  const [savingCatalog, setSavingCatalog] = useState(false)
  const [catalogEditorError, setCatalogEditorError] = useState<string | null>(null)
  const [pendingCatalogRestart, setPendingCatalogRestart] = useState<string | null>(null)
  const [catalogRestartConfirmation, setCatalogRestartConfirmation] = useState<string | null>(null)
  const [restartingCatalog, setRestartingCatalog] = useState(false)
  const modelSlugs = useMemo(() => models.map(model => model.modelId).sort(), [models])

  const loadCatalogModels = useCallback(async () => {
    if (modelSlugs.length === 0) {
      setCatalogModels(new Map())
      setCatalogError(null)
      return
    }
    setCatalogLoading(true)
    setCatalogError(null)
    try {
      const entries = await getLocalCodexModelCatalogOverrides(modelSlugs)
      setCatalogModels(new Map(entries.map(entry => [entry.slug, entry])))
    } catch (loadError) {
      setCatalogModels(new Map())
      setCatalogError(getErrorMessage(loadError, t('workbench.codex_catalog_load_failed')))
    } finally {
      setCatalogLoading(false)
    }
  }, [modelSlugs, t])

  useEffect(() => {
    void Promise.resolve().then(loadCatalogModels)
  }, [loadCatalogModels])

  const toggleProvider = useCallback((providerId: string) => {
    setExpandedProviderIds(current => {
      const next = new Set(current)
      if (next.has(providerId)) {
        next.delete(providerId)
      } else {
        next.add(providerId)
      }
      return next
    })
  }, [])

  const restartAfterCatalogChange = async (slug: string): Promise<boolean> => {
    const restart = await requestLocalExecutor<{
      restarted: boolean
      requiresConfirmation: boolean
    }>('runtime.codex.app_server.restart', { ifIdle: true })
    if (restart.restarted) {
      setPendingCatalogRestart(null)
      setCatalogRestartConfirmation(null)
      await onRefresh()
      return true
    } else if (restart.requiresConfirmation) {
      setPendingCatalogRestart(slug)
      setCatalogRestartConfirmation(slug)
      return false
    } else {
      throw new Error(t('workbench.local_model_catalog_restart_failed'))
    }
  }

  const saveCatalog = async (entry: LocalModelCatalogEntry) => {
    if (!editingCatalog) return
    setSavingCatalog(true)
    setCatalogEditorError(null)
    try {
      await saveLocalCodexModelCatalogOverride(editingCatalog.catalog.slug, entry)
      const slug = editingCatalog.catalog.slug
      const applied = await restartAfterCatalogChange(slug)
      await loadCatalogModels()
      if (applied) {
        setEditingCatalog(null)
      }
    } catch (saveError) {
      setCatalogEditorError(getErrorMessage(saveError, t('workbench.codex_catalog_save_failed')))
    } finally {
      setSavingCatalog(false)
    }
  }

  const restoreCatalog = async (slug: string) => {
    setCatalogError(null)
    try {
      await deleteLocalCodexModelCatalogOverride(slug)
      await restartAfterCatalogChange(slug)
      await loadCatalogModels()
    } catch (restoreError) {
      setCatalogError(getErrorMessage(restoreError, t('workbench.codex_catalog_restore_failed')))
    }
  }

  const confirmCatalogRestart = async () => {
    setRestartingCatalog(true)
    setCatalogError(null)
    try {
      await requestLocalExecutor('runtime.codex.app_server.restart', { force: true })
      setPendingCatalogRestart(null)
      setCatalogRestartConfirmation(null)
      await onRefresh()
      await loadCatalogModels()
      setEditingCatalog(null)
    } catch (restartError) {
      setCatalogError(
        getErrorMessage(restartError, t('workbench.local_model_catalog_restart_failed'))
      )
    } finally {
      setRestartingCatalog(false)
    }
  }

  return (
    <div data-testid="codex-official-models-section" className="grid gap-2">
      <div className="flex min-h-11 items-start justify-between gap-3 rounded-lg border border-border bg-background px-3 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('workbench.codex_official_models_title')}
            </h3>
            {!loading && (
              <span className="rounded-full bg-background px-2 py-0.5 text-xs text-text-secondary">
                {t('workbench.codex_models_count', { count: models.length })}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-5 text-text-secondary">
            {t('workbench.codex_official_models_desc')}
          </p>
        </div>
        <button
          type="button"
          data-testid="codex-official-models-refresh-button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t('workbench.runtime_config_refresh')}
          title={t('workbench.runtime_config_refresh')}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </button>
      </div>

      {loading ? (
        <div className="rounded-lg border border-border bg-background px-3 py-3 text-sm text-text-secondary">
          {t('workbench.codex_official_models_loading')}
        </div>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-3 text-sm text-red-500">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : providers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-background px-3 py-3 text-sm text-text-secondary">
          {t('workbench.codex_official_models_empty')}
        </div>
      ) : (
        providers.map(provider => {
          const expanded = expandedProviderIds.has(provider.id)
          return (
            <div
              key={provider.id}
              data-testid={`codex-model-provider-${provider.id}`}
              className="rounded-lg border border-border bg-background"
            >
              <button
                type="button"
                data-testid={`codex-model-provider-toggle-${provider.id}`}
                aria-expanded={expanded}
                aria-controls={`codex-model-provider-panel-${provider.id}`}
                onClick={() => toggleProvider(provider.id)}
                className={`flex min-h-11 w-full flex-wrap items-center justify-between gap-3 px-3 py-3 text-left hover:bg-muted/40 ${
                  expanded ? 'border-b border-border' : ''
                }`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-text-primary">
                      {provider.displayName}
                    </h3>
                    <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-text-secondary">
                      {provider.type === 'official'
                        ? t('workbench.codex_provider_official')
                        : t('workbench.codex_provider_custom')}
                    </span>
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-text-secondary">
                    {provider.id}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-text-secondary">
                    {t('workbench.codex_models_count', { count: provider.models.length })}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 text-text-secondary transition-transform ${
                      expanded ? 'rotate-180' : ''
                    }`}
                  />
                </div>
              </button>

              {expanded && (
                <div id={`codex-model-provider-panel-${provider.id}`}>
                  {provider.error ? (
                    <div className="flex items-start gap-2 px-3 py-3 text-sm text-red-500">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{provider.error}</span>
                    </div>
                  ) : provider.models.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-text-secondary">
                      {t('workbench.codex_official_models_empty')}
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {provider.models.map(model => {
                        const catalog = catalogModels.get(model.modelId)
                        const pendingRestart = pendingCatalogRestart === model.modelId
                        return (
                          <div
                            key={`${provider.id}:${model.modelId}`}
                            data-testid={`codex-official-model-row-${provider.id}-${model.modelId}`}
                            className="flex min-h-11 flex-wrap items-center justify-between gap-3 px-3 py-3"
                          >
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="truncate text-sm font-semibold text-text-primary">
                                  {model.modelId}
                                </h3>
                                {model.isDefault && (
                                  <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                                    {t('workbench.codex_official_models_default')}
                                  </span>
                                )}
                                {catalog?.overridden && (
                                  <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-text-secondary">
                                    {t('workbench.codex_catalog_customized')}
                                  </span>
                                )}
                                {pendingRestart && (
                                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600">
                                    {t('workbench.local_model_catalog_pending_restart')}
                                  </span>
                                )}
                              </div>
                              {model.displayName !== model.modelId && (
                                <div className="mt-1 break-all text-xs text-text-secondary">
                                  {model.displayName}
                                </div>
                              )}
                              {model.description && (
                                <div className="mt-1 text-xs text-text-muted">
                                  {model.description}
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              {catalog?.overridden && (
                                <button
                                  type="button"
                                  data-testid={`codex-catalog-restore-${provider.id}-${model.modelId}`}
                                  onClick={() => void restoreCatalog(model.modelId)}
                                  className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
                                >
                                  {t('workbench.codex_catalog_restore')}
                                </button>
                              )}
                              <button
                                type="button"
                                data-testid={`codex-catalog-edit-${provider.id}-${model.modelId}`}
                                onClick={() => {
                                  if (!catalog) return
                                  setCatalogEditorError(null)
                                  setEditingCatalog({ model, catalog })
                                }}
                                disabled={!catalog || catalogLoading}
                                title={
                                  catalog
                                    ? t('workbench.codex_catalog_edit')
                                    : t('workbench.codex_catalog_unavailable')
                                }
                                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                                {t('workbench.codex_catalog_edit')}
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })
      )}
      {catalogError && (
        <div
          data-testid="codex-catalog-error"
          className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-3 text-sm text-red-500"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{catalogError}</span>
        </div>
      )}
      {editingCatalog && (
        <CodexCatalogEditorDialog
          key={editingCatalog.catalog.slug}
          model={editingCatalog.model}
          catalog={editingCatalog.catalog}
          saving={savingCatalog}
          error={catalogEditorError}
          onClose={() => {
            setCatalogEditorError(null)
            setEditingCatalog(null)
          }}
          onSave={entry => void saveCatalog(entry)}
        />
      )}
      {catalogRestartConfirmation && (
        <LocalModelCatalogRestartDialog
          restarting={restartingCatalog}
          onLater={() => setCatalogRestartConfirmation(null)}
          onRestart={() => void confirmCatalogRestart()}
        />
      )}
    </div>
  )
}

import { ConfirmDialog } from '@/components/common/ConfirmDialog'
