import { createPortal } from 'react-dom'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { DialogForm } from '@/components/common/DialogForm'
import { ProviderModelFields } from './ProviderModelFields'
import { ProviderConnectionTestButton } from './ProviderConnectionTestButton'
import {
  LOCAL_MODEL_PROVIDER_PROFILES,
  findLocalModelProviderProfile,
} from '@/features/model-settings/localModelProviders'
import {
  createPresetProviderModel,
  detectProviderPreset,
} from '@/features/model-settings/providerPresets'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Loader2, Plus, X, Eye, EyeOff } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'

import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  saveProviderConfiguration,
  type ModelConfigurationSnapshot,
  type ModelProvider,
  type ProviderModel,
} from '@/features/model-settings/providerModelConfiguration'

const BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8'
const INPUT =
  'min-h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 md:min-h-8'
const PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-45 md:min-h-8'
const FORMATS = ['openai-responses', 'openai-chat-completions', 'anthropic-messages'] as const

type ProviderDraft = ModelProvider & { api_key_configured?: boolean }

/** Edit one connection and its models while keeping discovery independent from saving. */
export function ProviderEditor({
  initial,
  snapshot,
  onClose,
  editingModelId,
}: {
  initial: ProviderDraft
  snapshot: ModelConfigurationSnapshot
  onClose: () => void
  editingModelId?: string
}) {
  const { t } = useTranslation('modelConnections')
  const existing = snapshot.providers.some(provider => provider.id === initial.id)
  const [presetId, setPresetId] = useState(() => (existing ? detectProviderPreset(initial) : ''))
  const [showKey, setShowKey] = useState(false)
  const [expandedModels, setExpandedModels] = useState<Set<string>>(
    () => new Set(editingModelId ? [editingModelId] : [])
  )
  const [draft, setDraft] = useState<ProviderDraft>(initial)
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const discoverySequence = useRef(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [discard, setDiscard] = useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  useEffect(
    () => () => {
      discoverySequence.current += 1
    },
    []
  )
  /** Update draft fields and invalidate discovery results when connection settings change. */
  const patch = (value: Partial<ProviderDraft>) => {
    if (
      ['base_url', 'api_key', 'api_format', 'models_path', 'models_api_key_header'].some(
        key => key in value
      )
    ) {
      // A response for an older address/key must never replace the current connection's list.
      discoverySequence.current += 1
      setDiscovered(null)
      setDiscovering(false)
      setDiscoveryError(null)
    }
    setDraft(current => ({ ...current, ...value }))
  }
  /** Update a single model draft by stable local ID. */
  const patchModel = (id: string, value: Partial<ProviderModel>) =>
    setDraft(current => ({
      ...current,
      models: current.models.map(model => (model.id === id ? { ...model, ...value } : model)),
    }))

  const requestClose = () => {
    if (pending) return
    if (dirty) setDiscard(true)
    else onClose()
  }
  const dialogRef = useDialogKeyboard<HTMLFormElement>(
    requestClose,
    !discard,
    '[data-testid="provider-preset"]'
  )
  const custom = presetId === 'custom'
  function selectPreset(id: string) {
    const profile = findLocalModelProviderProfile(id)
    setPresetId(id)
    patch({
      name: id === 'custom' ? t('newProvider') : profile.displayName,
      base_url: profile.baseUrl,
      api_format: profile.apiFormat,
      request_path: profile.requestPath,
      models_path: profile.modelsPath,
      models_api_key_header: profile.modelsApiKeyHeader,
      api_key: undefined,
    })
  }

  /** Append one model without duplicating an existing upstream model ID. */
  function appendModel(modelId = '') {
    const model_id = modelId.trim()
    const model = createPresetProviderModel(presetId, model_id)
    if (!model_id) setExpandedModels(previous => new Set([...previous, model.id]))
    setDraft(current => {
      if (model_id && current.models.some(model => model.model_id.trim() === model_id))
        return current
      return { ...current, models: [...current.models, model] }
    })
  }

  /** Persist this provider against the captured revision and close only after a successful refresh. */
  async function save(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      if (!existing && !draft.models.length) throw new Error(t('selectAtLeastOne'))
      const next = draft
      const found = snapshot.providers.some(provider => provider.id === initial.id)
      const providers = found
        ? snapshot.providers.map(provider => (provider.id === initial.id ? next : provider))
        : [...snapshot.providers, next]
      await saveProviderConfiguration(snapshot.revision, providers)
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('failed'))
    } finally {
      setPending(false)
    }
  }

  /** Retrieve candidates for the current unsaved connection and discard stale responses. */
  async function discover() {
    const sequence = ++discoverySequence.current
    setDiscovering(true)
    setDiscovered(null)
    setDiscoveryError(null)
    try {
      const profile = findLocalModelProviderProfile(presetId)
      const models = await invokeDesktopHost<string[]>('modelConfiguration.discover', {
        providerId: initial.id,
        provider: {
          base_url: custom
            ? draft.base_url.trim()
            : (profile.modelsBaseUrl ?? draft.base_url.trim()),
          api_key: draft.api_key,
          api_format: draft.api_format,
          models_path: draft.models_path,
          models_api_key_header: draft.models_api_key_header,
        },
      })
      if (sequence === discoverySequence.current)
        setDiscovered(
          profile.allowedModelIds
            ? models.filter(id => profile.allowedModelIds!.includes(id))
            : models
        )
    } catch (failure) {
      if (sequence === discoverySequence.current)
        setDiscoveryError(failure instanceof Error ? failure.message : t('failed'))
    } finally {
      if (sequence === discoverySequence.current) setDiscovering(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/15 px-4 py-6"
      onClick={event => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      {!discard && (
        <DialogForm
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="provider-editor-title"
          onSubmit={event => void save(event)}
          className="flex max-h-[90vh] w-full max-w-[600px] flex-col overflow-hidden rounded-[20px] border border-border bg-popover text-text-primary shadow-lg"
          data-testid="provider-editor"
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <h2 id="provider-editor-title" className="heading-small">
                {existing ? t('editModels') : t('addProvider')}
              </h2>
              <p className="mt-1 text-xs text-text-secondary">{t('editorDescription')}</p>
            </div>
            <button
              type="button"
              data-testid="provider-editor-close"
              className={BUTTON}
              disabled={pending}
              onClick={requestClose}
              aria-label={t('cancel')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 space-y-4 overflow-y-auto p-5">
            <label className="grid gap-1.5 text-sm text-text-primary">
              {t('service')}
              <select
                data-testid="provider-preset"
                className={INPUT}
                value={presetId}
                disabled={existing || pending || draft.models.length > 0}
                onChange={event => selectPreset(event.target.value)}
              >
                <option value="" disabled>
                  {t('chooseService')}
                </option>
                {LOCAL_MODEL_PROVIDER_PROFILES.filter(profile => profile.id !== 'custom').map(
                  profile => (
                    <option key={profile.id} value={profile.id}>
                      {profile.displayNameKey
                        ? t(profile.displayNameKey, { ns: 'common' })
                        : profile.displayName}
                    </option>
                  )
                )}
                <option value="custom">{t('customInterface')}</option>
              </select>
            </label>
            <fieldset disabled={pending} className="space-y-3">
              {existing && !custom && (
                <label className="flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    data-testid="provider-enabled"
                    checked={draft.enabled !== false}
                    onChange={event => patch({ enabled: event.target.checked })}
                  />
                  {t('enabled')}
                </label>
              )}
              <div className="grid gap-3">
                {custom && (
                  <label className="space-y-1 text-sm text-text-secondary">
                    {t('name')}
                    <input
                      data-testid="provider-name"
                      className={INPUT}
                      required
                      value={draft.name}
                      onChange={event => patch({ name: event.target.value })}
                    />
                  </label>
                )}
                {custom && (
                  <label className="space-y-1 text-sm text-text-secondary">
                    {t('protocol')}
                    <select
                      data-testid="provider-protocol"
                      className={INPUT}
                      value={draft.api_format}
                      onChange={event =>
                        patch({
                          api_format: event.target.value as ModelProvider['api_format'],
                          request_path: undefined,
                        })
                      }
                    >
                      {FORMATS.map(format => (
                        <option key={format}>{format}</option>
                      ))}
                    </select>
                  </label>
                )}
                {custom && (
                  <label className="space-y-1 text-sm text-text-secondary">
                    Base URL
                    <input
                      data-testid="provider-base-url"
                      className={INPUT}
                      type="url"
                      required
                      placeholder="https://gateway.example/v1"
                      value={draft.base_url}
                      onChange={event => patch({ base_url: event.target.value })}
                    />
                  </label>
                )}
                <label className="space-y-1 text-sm text-text-secondary">
                  API Key
                  <div className="relative">
                    <input
                      data-testid="provider-api-key"
                      className={`${INPUT} pr-12`}
                      type={showKey ? 'text' : 'password'}
                      required={!custom && !draft.api_key_configured}
                      autoComplete="new-password"
                      placeholder={
                        draft.api_key_configured
                          ? t('keepKey')
                          : draft.api_key_ref
                            ? t('missingKey')
                            : custom
                              ? t('optionalKey')
                              : t('enterKey')
                      }
                      value={draft.api_key ?? ''}
                      onChange={event => patch({ api_key: event.target.value || undefined })}
                    />
                    <button
                      type="button"
                      data-testid="provider-key-visibility"
                      className="absolute inset-y-0 right-0 flex min-w-11 items-center justify-center text-text-secondary"
                      aria-label={showKey ? t('hideKey') : t('showKey')}
                      onClick={() => setShowKey(value => !value)}
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </label>
              </div>
              {custom ? (
                <details className="space-y-3">
                  <summary className="cursor-pointer text-sm text-text-secondary">
                    {t('connectionAdvanced')}
                  </summary>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <label className="space-y-1 text-sm text-text-secondary">
                      {t('requestPath')}
                      <input
                        data-testid="provider-request-path"
                        className={INPUT}
                        value={draft.request_path ?? ''}
                        placeholder={t('automatic')}
                        onChange={event => patch({ request_path: event.target.value || undefined })}
                      />
                    </label>
                    <label className="space-y-1 text-sm text-text-secondary">
                      {t('modelsPath')}
                      <input
                        data-testid="provider-models-path"
                        className={INPUT}
                        value={draft.models_path ?? ''}
                        placeholder="/models"
                        onChange={event => patch({ models_path: event.target.value || undefined })}
                      />
                    </label>
                    <label className="space-y-1 text-sm text-text-secondary">
                      {t('listAuth')}
                      <select
                        data-testid="provider-models-auth"
                        className={INPUT}
                        value={draft.models_api_key_header ?? 'Authorization'}
                        onChange={event =>
                          patch({
                            models_api_key_header: event.target.value as
                              | 'Authorization'
                              | 'X-Api-Key',
                          })
                        }
                      >
                        <option>Authorization</option>
                        <option>X-Api-Key</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-sm text-text-primary">
                      <input
                        data-testid="provider-enabled"
                        type="checkbox"
                        checked={draft.enabled !== false}
                        onChange={event => patch({ enabled: event.target.checked })}
                      />
                      {t('enabled')}
                    </label>
                  </div>
                  <p
                    className="break-all font-mono text-xs text-text-secondary"
                    data-testid="provider-request-preview"
                  >
                    {draft.base_url.replace(/\/+$/, '')}
                    {draft.request_path ||
                      (draft.api_format === 'openai-responses'
                        ? '/responses'
                        : draft.api_format === 'openai-chat-completions'
                          ? '/chat/completions'
                          : draft.base_url.endsWith('/v1')
                            ? '/messages'
                            : '/v1/messages')}
                  </p>
                </details>
              ) : (
                presetId && <p className="text-xs text-text-secondary">{t('presetHint')}</p>
              )}
              <div className="space-y-2 border-t border-border pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-medium text-text-primary">{t('models')}</h4>
                  <button
                    type="button"
                    className={BUTTON}
                    data-testid="provider-discover"
                    disabled={
                      pending ||
                      discovering ||
                      !presetId ||
                      !validDiscoveryUrl(draft.base_url) ||
                      (!custom && !draft.api_key?.trim() && !draft.api_key_configured)
                    }
                    onClick={() => void discover()}
                  >
                    {discovering && <Loader2 className="h-4 w-4 animate-spin" />}
                    {discovering
                      ? t('discovering')
                      : discovered
                        ? t('refreshModels')
                        : t('discover')}
                  </button>
                </div>
                <p className="text-xs text-text-secondary">{t('discoveryHint')}</p>
                {discoveryError && (
                  <p
                    role="alert"
                    data-testid="provider-discovery-error"
                    className="text-sm text-red-500"
                  >
                    {discoveryError}
                  </p>
                )}
                {discovered?.length === 0 && (
                  <p data-testid="provider-discovery-empty" className="text-sm text-text-secondary">
                    {t('discoveryEmpty')}
                  </p>
                )}
                {discovered && discovered.length > 0 && (
                  <div
                    className="max-h-48 space-y-1 overflow-y-auto rounded-md bg-surface p-3"
                    data-testid="provider-discovered-models"
                  >
                    {discovered.map(id => {
                      const exists = draft.models.some(model => model.model_id.trim() === id)
                      return (
                        <div
                          key={id}
                          className="flex min-h-9 items-center justify-between gap-3 text-sm text-text-primary"
                        >
                          <label className="flex min-h-11 flex-1 cursor-pointer items-center gap-3 md:min-h-9">
                            <input
                              type="checkbox"
                              data-testid={`provider-discovered-${id}`}
                              aria-label={`${t('addModel')} ${id}`}
                              checked={exists}
                              disabled={pending}
                              onChange={event =>
                                event.target.checked
                                  ? appendModel(id)
                                  : patch({
                                      models: draft.models.filter(
                                        model => model.model_id.trim() !== id
                                      ),
                                    })
                              }
                            />
                            <span className="min-w-0 break-all">{id}</span>
                          </label>
                        </div>
                      )
                    })}
                  </div>
                )}
                <button
                  type="button"
                  className={BUTTON}
                  data-testid="provider-model-add"
                  disabled={pending || !presetId}
                  onClick={() => appendModel()}
                >
                  <Plus className="h-4 w-4" />
                  {t('manual')}
                </button>
                <div className="divide-y divide-border">
                  {draft.models.map(model => (
                    <div
                      key={model.id}
                      className="space-y-2 py-3"
                      data-testid={`provider-model-editor-${model.id}`}
                    >
                      <details
                        open={expandedModels.has(model.id)}
                        onToggle={event => {
                          const open = event.currentTarget.open
                          setExpandedModels(current => {
                            const next = new Set(current)
                            if (open) next.add(model.id)
                            else next.delete(model.id)
                            return next
                          })
                        }}
                      >
                        <summary className="cursor-pointer text-sm text-text-primary">
                          {model.display_name || model.model_id || t('newModel')}
                          <span className="ml-2 text-xs text-text-secondary">
                            {t('modelSettings')}
                          </span>
                        </summary>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <input
                            className={`${INPUT} flex-1`}
                            data-testid={`provider-model-id-${model.id}`}
                            aria-label={t('modelId')}
                            value={model.model_id}
                            required
                            placeholder={t('modelId')}
                            onChange={event =>
                              patchModel(model.id, { model_id: event.target.value })
                            }
                          />
                          <input
                            className={`${INPUT} flex-1`}
                            data-testid={`provider-model-name-${model.id}`}
                            aria-label={t('displayName')}
                            value={model.display_name ?? ''}
                            placeholder={t('displayName')}
                            onChange={event =>
                              patchModel(model.id, {
                                display_name: event.target.value || undefined,
                              })
                            }
                          />
                          <label className="flex items-center gap-1 text-xs text-text-secondary">
                            <input
                              data-testid={`provider-model-enabled-${model.id}`}
                              type="checkbox"
                              checked={model.enabled !== false}
                              onChange={event =>
                                patchModel(model.id, { enabled: event.target.checked })
                              }
                            />
                            {t('enabled')}
                          </label>
                          <button
                            type="button"
                            className={BUTTON}
                            data-testid={`provider-model-remove-${model.id}`}
                            onClick={() =>
                              patch({ models: draft.models.filter(item => item.id !== model.id) })
                            }
                          >
                            {t('remove')}
                          </button>
                        </div>
                        <ProviderModelFields
                          model={model}
                          provider={draft}
                          onChange={value => patchModel(model.id, value)}
                        />
                      </details>
                    </div>
                  ))}
                </div>
              </div>
              {error && (
                <p
                  role="alert"
                  data-testid="provider-editor-error"
                  className="text-sm text-red-500"
                >
                  {error}
                </p>
              )}
            </fieldset>
          </div>
          <div className="grid grid-cols-1 gap-3 border-t border-border px-5 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
            <ProviderConnectionTestButton
              provider={draft}
              disabled={pending}
              testId="provider-editor-test"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={BUTTON}
                data-testid="provider-editor-cancel"
                disabled={pending}
                onClick={() => (dirty ? setDiscard(true) : onClose())}
              >
                {t('cancel')}
              </button>
              <button
                type="submit"
                className={PRIMARY}
                data-testid="provider-editor-save"
                disabled={pending || !presetId || (!existing && !draft.models.length)}
              >
                {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                {existing ? t('save') : t('addProvider')}
              </button>
            </div>
          </div>
        </DialogForm>
      )}
      <ConfirmDialog
        open={discard}
        title={t('discard')}
        description={t('discardDescription')}
        cancelLabel={t('cancel')}
        confirmLabel={t('confirm')}
        confirmTestId="provider-discard-confirm"
        onClose={() => setDiscard(false)}
        onConfirm={onClose}
      />
    </div>,
    document.body
  )
}

/** Enable discovery only for HTTP(S) base URLs without embedded credentials or query data. */
function validDiscoveryUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}
