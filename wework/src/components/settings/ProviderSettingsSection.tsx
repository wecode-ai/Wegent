import { ProviderEditor } from './ProviderEditor'
import { ProviderCredentialRecovery } from './ProviderCredentialRecovery'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

import { isElectronRuntime } from '@/lib/runtime-environment'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  getProviderConfigurationState,
  chooseProviderConfiguration,
  initializeProviderModelConfiguration,
  reloadProviderConfiguration,
  saveProviderConfiguration,
  subscribeProviderConfiguration,
  type ModelConfigurationSnapshot,
  type ModelProvider,
  type PublicModelProvider,
} from '@/features/model-settings/providerModelConfiguration'

const BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8'

type ProviderDraft = ModelProvider & { api_key_configured?: boolean }

/** Manage local provider connections without exposing file controls or changing cloud catalogs. */
export function ProviderSettingsSection() {
  const { t } = useTranslation('modelConnections')
  const { snapshot, error: loadError } = useSyncExternalStore(
    subscribeProviderConfiguration,
    getProviderConfigurationState
  )
  const [editor, setEditor] = useState<{
    provider: ProviderDraft
    snapshot: ModelConfigurationSnapshot
    editingModelId?: string
  } | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<{
    title: string
    description: string
    run: () => Promise<void>
  } | null>(null)
  const available = isElectronRuntime()

  useEffect(() => {
    if (available) void initializeProviderModelConfiguration()
  }, [available])

  if (!available) return null

  /** Run a confirmed provider operation with shared pending and error feedback. */
  async function perform(action: () => Promise<void>) {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('failed'))
    } finally {
      setPending(false)
    }
  }

  /** Open an empty in-memory connection draft using the current configuration revision. */
  const addProvider = () => {
    if (!snapshot) return
    setEditor({
      snapshot,
      provider: {
        id: `provider-${crypto.randomUUID()}`,
        name: t('newProvider'),
        base_url: '',
        api_format: 'openai-responses',
        models: [],
      },
    })
  }
  /** Clone a public connection into an isolated draft so cancellation has no persistence effects. */
  const editProvider = (provider: PublicModelProvider, editingModelId?: string) => {
    if (snapshot) setEditor({ snapshot, provider: structuredClone(provider), editingModelId })
  }

  return (
    <section data-testid="provider-settings-section" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">{t('title')}</h3>
        </div>
        <button
          type="button"
          data-testid="provider-add"
          className={BUTTON}
          disabled={!snapshot || pending || !!editor || !!loadError}
          onClick={addProvider}
        >
          <Plus className="h-4 w-4" />
          {t('addProvider')}
        </button>
      </div>
      {!snapshot && <p className="text-sm text-text-secondary">{t('loading')}</p>}

      {loadError && !editor && (
        <button
          type="button"
          className={BUTTON}
          data-testid="provider-retry"
          disabled={pending}
          onClick={() => void perform(reloadProviderConfiguration)}
        >
          {t('retry')}
        </button>
      )}
      {(error || loadError) && (
        <p
          role="alert"
          data-testid="provider-settings-error"
          className="break-words text-sm text-red-500"
        >
          {error || loadError}
        </p>
      )}
      {loadError && !editor && (
        <button
          type="button"
          className={BUTTON}
          data-testid="provider-choose-recovery-file"
          disabled={pending}
          onClick={() => void perform(chooseProviderConfiguration)}
        >
          {t('recoveryChooseFile')}
        </button>
      )}
      {!editor && (
        <ProviderCredentialRecovery
          disabled={pending}
          configurationAvailable={!!snapshot && !loadError}
        />
      )}
      {editor && (
        <ProviderEditor
          key={editor.provider.id}
          initial={editor.provider}
          snapshot={editor.snapshot}
          editingModelId={editor.editingModelId}
          onClose={() => setEditor(null)}
        />
      )}
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-background">
        {snapshot?.providers.map(provider => (
          <details
            key={provider.id}
            data-testid={`provider-row-${provider.id}`}
            className="px-4 py-4"
          >
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <ChevronDown className="h-4 w-4 shrink-0" />
                <span className="truncate text-sm font-medium text-text-primary">
                  {provider.name}
                </span>
                <span className="text-xs text-text-secondary">
                  {t('modelCount', { count: provider.models.length })}
                </span>
                {provider.enabled === false && (
                  <span className="text-xs text-text-secondary">{t('disabled')}</span>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={BUTTON}
                  data-testid={`provider-edit-${provider.id}`}
                  disabled={pending || !!loadError}
                  onClick={event => {
                    event.preventDefault()
                    editProvider(provider)
                  }}
                >
                  {t('edit')}
                </button>
                <button
                  type="button"
                  className={BUTTON}
                  data-testid={`provider-delete-${provider.id}`}
                  disabled={pending || !!loadError}
                  onClick={event => {
                    event.preventDefault()
                    if (snapshot)
                      setConfirmation({
                        title: t('deleteProvider'),
                        description: t('deleteDescription', {
                          name: provider.name,
                          count: provider.models.length,
                        }),
                        run: () =>
                          saveProviderConfiguration(
                            snapshot.revision,
                            snapshot.providers.filter(item => item.id !== provider.id)
                          ),
                      })
                  }}
                >
                  {t('delete')}
                </button>
              </div>
            </summary>
            <div className="mt-2 space-y-1 pl-6">
              <p className="break-all text-xs text-text-secondary">
                {provider.base_url} · {provider.api_format} ·{' '}
                {provider.api_key_configured
                  ? t('keyConfigured')
                  : provider.api_key_ref
                    ? t('missingKey')
                    : t('noKey')}
              </p>
              {provider.models.map(model => (
                <div
                  key={model.id}
                  className="flex min-h-8 flex-wrap items-center justify-between gap-2 text-sm"
                  data-testid={`provider-model-${model.id}`}
                >
                  <span className="text-text-primary">{model.display_name || model.model_id}</span>
                  <span className="break-all font-mono text-xs text-text-secondary">
                    {model.model_id}
                    {model.enabled === false ? ` · ${t('disabled')}` : ''}
                  </span>
                  <button
                    type="button"
                    className={BUTTON}
                    data-testid={`provider-model-edit-${model.id}`}
                    disabled={pending || !!loadError}
                    onClick={() => editProvider(provider, model.id)}
                  >
                    {t('editModel')}
                  </button>
                </div>
              ))}
              {provider.models.length === 0 && (
                <p className="text-sm text-text-secondary">{t('emptyModels')}</p>
              )}
            </div>
          </details>
        ))}
        {snapshot?.providers.length === 0 && (
          <p className="px-4 py-4 text-xs text-text-secondary">{t('description')}</p>
        )}
      </div>
      <ConfirmDialog
        open={!!confirmation}
        title={confirmation?.title ?? ''}
        description={confirmation?.description ?? ''}
        cancelLabel={t('cancel')}
        confirmLabel={t('confirm')}
        confirmTestId="provider-action-confirm"
        pending={pending}
        onClose={() => setConfirmation(null)}
        onConfirm={() => {
          if (confirmation)
            void perform(async () => {
              await confirmation.run()
              setConfirmation(null)
            })
        }}
      />
    </section>
  )
}
