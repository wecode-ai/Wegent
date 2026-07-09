import {
  AlertCircle,
  ChevronDown,
  Loader2,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { getLocalCodexOfficialModels } from '@/api/local/codexOfficialModels'
import { getLocalCodexAuthStatus, type LocalRuntimeAuthStatus } from '@/api/local/runtimeAuthStatus'
import { createModelApi } from '@/api/models'
import { createUserApi } from '@/api/users'
import type { UserRuntime, UserRuntimeConfig } from '@/api/users'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import type { CodexOfficialModelList } from '@/features/model-settings/codexOfficialModels'
import { testLocalModelConnection } from '@/features/model-settings/localModelConnectionTest'
import {
  buildLocalModelRequestUrl,
  deleteLocalModelConfig,
  DEFAULT_LOCAL_MODEL_REQUEST_PATH,
  listLocalModelConfigs,
  LOCAL_MODEL_SETTINGS_CHANGED_EVENT,
  normalizeLocalModelBaseUrl,
  normalizeLocalModelRequestPath,
  saveLocalModelConfig,
  splitLocalModelRequestUrl,
  type LocalModelConfig,
  type LocalModelWebSearchMode,
} from '@/features/model-settings/localModelSettings'
import { useTranslation } from '@/hooks/useTranslation'
import { isClaudeCodeDevice } from '@/lib/device-capabilities'
import type { UnifiedModel } from '@/types/api'
import type { DeviceInfo } from '@/types/devices'

interface CloudRuntimeSettingsConnection {
  isConnected: boolean
  apiBaseUrl?: string
  token: string | null
}

function createRuntimeSettingsApis(connection: CloudRuntimeSettingsConnection) {
  if (!connection.isConnected || !connection.apiBaseUrl || !connection.token) {
    throw new Error('Cloud connection is required')
  }
  const client = createHttpClient({
    baseUrl: connection.apiBaseUrl,
    getToken: () => connection.token,
    redirectOnUnauthorized: false,
  })
  return {
    deviceApi: createDeviceApi(client),
    modelApi: createModelApi(client),
    userApi: createUserApi(client),
  }
}

function formatRuntimeDate(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function shortDigest(value?: string | null) {
  if (!value) return ''
  return value.length > 16 ? `${value.slice(0, 16)}...` : value
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function validateAuthJsonContent(content: string, invalidMessage: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(invalidMessage)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(invalidMessage)
  }
}

function modelLabel(model: UnifiedModel): string {
  return model.displayName || model.name
}

function modelMeta(model: UnifiedModel): string {
  return [model.provider, model.runtime?.family, model.type].filter(Boolean).join(' · ')
}

function LocalCodexModelRow({
  status,
  loading,
  error,
  onRefresh,
}: {
  status: LocalRuntimeAuthStatus | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}) {
  const { t } = useTranslation('common')
  const exists = status?.exists === true
  return (
    <div
      data-testid="local-codex-model-row"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-3"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-text-primary">
            {t('workbench.local_codex_model_title', '当前设备认证')}
          </h3>
          <span
            data-testid="local-codex-model-status-pill"
            className={`rounded-full px-2 py-0.5 text-xs ${
              exists ? 'bg-primary/10 text-primary' : 'bg-muted text-text-muted'
            }`}
          >
            {exists
              ? t('workbench.runtime_config_configured', '已配置')
              : t('workbench.runtime_config_not_configured', '未配置')}
          </span>
        </div>
        <div className="mt-1 break-all text-xs leading-5 text-text-secondary">
          {t('workbench.local_codex_auth_path_value', {
            defaultValue: '本机 {{path}}',
            path: status?.targetPath ?? '~/.codex/auth.json',
          })}
          {formatRuntimeDate(status?.updatedAt) && (
            <span className="ml-2">
              {t('workbench.runtime_config_updated_at', '更新时间')}:{' '}
              {formatRuntimeDate(status?.updatedAt)}
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
          <ShieldCheck className="h-3.5 w-3.5" />
          {status?.sha256
            ? `SHA-256 ${shortDigest(status.sha256)}`
            : t('workbench.local_codex_auth_no_digest', '没有可显示的摘要')}
        </div>
        {error && <div className="mt-1 text-xs text-red-500">{error}</div>}
      </div>
      <button
        type="button"
        data-testid="local-codex-auth-refresh-button"
        onClick={onRefresh}
        disabled={loading}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={t('workbench.runtime_config_refresh', '刷新')}
        title={t('workbench.runtime_config_refresh', '刷新')}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      </button>
    </div>
  )
}

interface LocalModelFormState {
  displayName: string
  group: string
  modelId: string
  baseUrl: string
  requestPath: string
  apiKey: string
  contextWindow: string
  webSearchMode: LocalModelWebSearchMode
  imageGenerationEnabled: boolean
  enabled: boolean
}

type LocalModelTestResult =
  | {
      kind: 'success'
      message: string
    }
  | {
      kind: 'error'
      message: string
    }

type PendingLocalModelFormAction =
  | { kind: 'create' }
  | { kind: 'edit'; model: LocalModelConfig }
  | { kind: 'reset' }
  | { kind: 'delete'; model: LocalModelConfig }

const EMPTY_LOCAL_MODEL_FORM: LocalModelFormState = {
  displayName: '',
  group: '',
  modelId: '',
  baseUrl: '',
  requestPath: DEFAULT_LOCAL_MODEL_REQUEST_PATH,
  apiKey: '',
  contextWindow: '',
  webSearchMode: 'disabled',
  imageGenerationEnabled: false,
  enabled: true,
}

const LOCAL_MODEL_FIELD_CLASS =
  'h-9 rounded-md border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-primary disabled:cursor-not-allowed disabled:bg-surface disabled:text-text-muted'
const LOCAL_MODEL_COMPOUND_INPUT_CLASS =
  'h-9 rounded-md border border-border bg-background focus-within:border-primary'
const LOCAL_MODEL_SEGMENT_INPUT_CLASS =
  'min-w-0 bg-transparent px-3 text-sm text-text-primary outline-none placeholder:text-text-muted disabled:cursor-not-allowed disabled:bg-surface disabled:text-text-muted'

const LOCAL_MODEL_WEB_SEARCH_OPTIONS: Array<{
  value: LocalModelWebSearchMode
  labelKey: string
}> = [
  {
    value: 'disabled',
    labelKey: 'workbench.local_model_web_search_disabled',
  },
  {
    value: 'cached',
    labelKey: 'workbench.local_model_web_search_cached',
  },
  {
    value: 'live',
    labelKey: 'workbench.local_model_web_search_live',
  },
]

const LOCAL_MODEL_IMAGE_GENERATION_OPTIONS: Array<{
  value: 'disabled' | 'enabled'
  labelKey: string
}> = [
  {
    value: 'disabled',
    labelKey: 'workbench.local_model_codex_feature_disabled',
  },
  {
    value: 'enabled',
    labelKey: 'workbench.local_model_codex_feature_enabled',
  },
]

function localModelWebSearchLabel(
  mode: LocalModelWebSearchMode,
  t: ReturnType<typeof useTranslation>['t']
): string {
  const option =
    LOCAL_MODEL_WEB_SEARCH_OPTIONS.find(candidate => candidate.value === mode) ??
    LOCAL_MODEL_WEB_SEARCH_OPTIONS[0]
  return t(option.labelKey)
}

function localModelImageGenerationLabel(
  enabled: boolean,
  t: ReturnType<typeof useTranslation>['t']
): string {
  return t(
    enabled
      ? 'workbench.local_model_codex_feature_enabled'
      : 'workbench.local_model_codex_feature_disabled'
  )
}

function localModelResponsesUrl(baseUrl: string, requestPath: string): string | null {
  if (!baseUrl.trim()) return null
  try {
    return buildLocalModelRequestUrl(baseUrl, requestPath)
  } catch {
    return null
  }
}

function isLocalModelFormDirty(
  form: LocalModelFormState,
  editingModel: LocalModelConfig | null
): boolean {
  if (!editingModel) {
    return (
      form.displayName.trim() !== '' ||
      form.group.trim() !== '' ||
      form.modelId.trim() !== '' ||
      form.baseUrl.trim() !== '' ||
      form.requestPath !== DEFAULT_LOCAL_MODEL_REQUEST_PATH ||
      form.apiKey.trim() !== '' ||
      form.contextWindow.trim() !== '' ||
      form.webSearchMode !== 'disabled' ||
      form.imageGenerationEnabled ||
      !form.enabled
    )
  }

  return (
    form.displayName !== editingModel.displayName ||
    form.group !== (editingModel.group ?? '') ||
    form.modelId !== editingModel.modelId ||
    form.baseUrl !== editingModel.baseUrl ||
    form.requestPath !== (editingModel.requestPath ?? DEFAULT_LOCAL_MODEL_REQUEST_PATH) ||
    form.apiKey.trim() !== '' ||
    form.contextWindow !== (editingModel.contextWindow?.toString() ?? '') ||
    form.webSearchMode !== (editingModel.webSearchMode ?? 'disabled') ||
    form.imageGenerationEnabled !== (editingModel.imageGenerationEnabled === true) ||
    form.enabled !== editingModel.enabled
  )
}

function LocalModelDiscardChangesDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('common')

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
      onClick={event => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-model-discard-changes-title"
        data-testid="local-model-discard-changes-dialog"
        className="w-full max-w-[420px] rounded-lg border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-600">
            <AlertCircle className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2
              id="local-model-discard-changes-title"
              className="text-sm font-semibold text-text-primary"
            >
              {t('workbench.local_model_discard_changes_title', '放弃未保存的模型配置？')}
            </h2>
            <p className="mt-1.5 text-xs leading-5 text-text-secondary">
              {t(
                'workbench.local_model_discard_changes_description',
                '当前表单有未保存内容，继续操作会丢弃这些修改。'
              )}
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="local-model-discard-changes-cancel-button"
            onClick={onCancel}
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="local-model-discard-changes-confirm-button"
            onClick={onConfirm}
            className="inline-flex h-8 items-center rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90"
          >
            {t('workbench.local_model_discard_changes_confirm', '放弃修改')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function CodexOfficialModelsSection({
  modelList,
  loading,
  error,
  onRefresh,
}: {
  modelList: CodexOfficialModelList | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}) {
  const { t } = useTranslation('common')
  const models = modelList?.models ?? []
  const providers = modelList?.providers ?? []
  const [expandedProviderIds, setExpandedProviderIds] = useState<Set<string>>(() => new Set())

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
        <div className="rounded-lg border border-dashed border-border bg-surface px-3 py-3 text-sm text-text-secondary">
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
                      {provider.models.map(model => (
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
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}

function LocalModelSettingsSection({
  cloudConnection,
  onOpenCloudSettings,
}: {
  cloudConnection: CloudRuntimeSettingsConnection
  onOpenCloudSettings?: () => void
}) {
  const { t } = useTranslation('common')
  const [models, setModels] = useState<LocalModelConfig[]>(() => listLocalModelConfigs())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formVisible, setFormVisible] = useState(false)
  const [form, setForm] = useState<LocalModelFormState>(EMPTY_LOCAL_MODEL_FORM)
  const [error, setError] = useState<string | null>(null)
  const [testingModel, setTestingModel] = useState(false)
  const [testResult, setTestResult] = useState<LocalModelTestResult | null>(null)
  const [pendingDiscardAction, setPendingDiscardAction] =
    useState<PendingLocalModelFormAction | null>(null)

  const refreshModels = useCallback(() => {
    setModels(listLocalModelConfigs())
  }, [])

  useEffect(() => {
    window.addEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, refreshModels)
    return () => window.removeEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, refreshModels)
  }, [refreshModels])

  const editingModel = useMemo(
    () => models.find(model => model.id === editingId) ?? null,
    [editingId, models]
  )
  const testRequestUrl = useMemo(
    () => localModelResponsesUrl(form.baseUrl, form.requestPath),
    [form.baseUrl, form.requestPath]
  )
  const formDirty = useMemo(
    () => formVisible && isLocalModelFormDirty(form, editingModel),
    [editingModel, form, formVisible]
  )

  const resetForm = () => {
    setEditingId(null)
    setFormVisible(false)
    setForm(EMPTY_LOCAL_MODEL_FORM)
    setError(null)
    setTestResult(null)
  }

  const performStartCreating = () => {
    setEditingId(null)
    setFormVisible(true)
    setForm(EMPTY_LOCAL_MODEL_FORM)
    setError(null)
    setTestResult(null)
  }

  const performStartEditing = (model: LocalModelConfig) => {
    setEditingId(model.id)
    setFormVisible(true)
    setForm({
      displayName: model.displayName,
      group: model.group ?? '',
      modelId: model.modelId,
      baseUrl: model.baseUrl,
      requestPath: model.requestPath ?? DEFAULT_LOCAL_MODEL_REQUEST_PATH,
      apiKey: '',
      contextWindow: model.contextWindow?.toString() ?? '',
      webSearchMode: model.webSearchMode ?? 'disabled',
      imageGenerationEnabled: model.imageGenerationEnabled === true,
      enabled: model.enabled,
    })
    setError(null)
    setTestResult(null)
  }

  const runDiscardableAction = (action: PendingLocalModelFormAction) => {
    if (formDirty) {
      setPendingDiscardAction(action)
      return
    }
    executeDiscardableAction(action)
  }

  const executeDiscardableAction = (action: PendingLocalModelFormAction) => {
    switch (action.kind) {
      case 'create':
        performStartCreating()
        break
      case 'edit':
        performStartEditing(action.model)
        break
      case 'reset':
        resetForm()
        break
      case 'delete':
        deleteModel(action.model)
        break
    }
  }

  const confirmDiscardChanges = () => {
    if (!pendingDiscardAction) return
    const action = pendingDiscardAction
    setPendingDiscardAction(null)
    executeDiscardableAction(action)
  }

  const cancelDiscardChanges = () => {
    setPendingDiscardAction(null)
  }

  const updateForm = (patch: Partial<LocalModelFormState>) => {
    setForm(current => ({ ...current, ...patch }))
    setTestResult(null)
  }

  const normalizeBaseUrlInput = () => {
    if (!form.baseUrl.trim()) return
    try {
      const splitUrl = splitLocalModelRequestUrl(form.baseUrl, form.requestPath)
      updateForm({
        baseUrl: normalizeLocalModelBaseUrl(splitUrl.baseUrl),
        requestPath: normalizeLocalModelRequestPath(splitUrl.requestPath),
      })
    } catch {
      // Keep invalid input visible; submit/test will show the validation message.
    }
  }

  const handleBaseUrlPaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text')
    const splitUrl = splitLocalModelRequestUrl(text, form.requestPath)
    if (splitUrl.baseUrl === text) return
    event.preventDefault()
    updateForm(splitUrl)
  }

  const normalizeRequestPathInput = () => {
    updateForm({ requestPath: normalizeLocalModelRequestPath(form.requestPath) })
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    try {
      saveLocalModelConfig({
        id: editingId,
        displayName: form.displayName,
        group: form.group,
        modelId: form.modelId,
        baseUrl: form.baseUrl,
        requestPath: form.requestPath,
        apiKey: form.apiKey.trim() ? form.apiKey : editingModel?.apiKey,
        contextWindow: form.contextWindow,
        webSearchMode: form.webSearchMode,
        imageGenerationEnabled: form.imageGenerationEnabled,
        enabled: form.enabled,
      })
      resetForm()
    } catch (saveError) {
      setError(getErrorMessage(saveError, t('workbench.local_model_save_failed', '保存模型失败')))
    }
  }

  const clearEditingApiKey = () => {
    if (!editingModel) return
    try {
      saveLocalModelConfig({
        id: editingModel.id,
        displayName: editingModel.displayName,
        group: editingModel.group,
        modelId: editingModel.modelId,
        baseUrl: editingModel.baseUrl,
        requestPath: editingModel.requestPath,
        apiKey: null,
        contextWindow: editingModel.contextWindow,
        webSearchMode: editingModel.webSearchMode,
        imageGenerationEnabled: editingModel.imageGenerationEnabled,
        enabled: editingModel.enabled,
      })
      performStartEditing({ ...editingModel, apiKey: undefined })
    } catch (clearError) {
      setError(
        getErrorMessage(
          clearError,
          t('workbench.local_model_clear_key_failed', '清除 API Key 失败')
        )
      )
    }
  }

  const handleTestModel = async () => {
    setError(null)
    setTestResult(null)
    setTestingModel(true)
    try {
      await testLocalModelConnection({
        baseUrl: form.baseUrl,
        requestPath: form.requestPath,
        modelId: form.modelId,
        apiKey: form.apiKey.trim() ? form.apiKey : editingModel?.apiKey,
      })
      setTestResult({
        kind: 'success',
        message: t('workbench.local_model_test_success', '模型连接正常'),
      })
    } catch (testError) {
      const message = getErrorMessage(
        testError,
        t('workbench.local_model_test_failed', '模型测试失败')
      )
      setTestResult({
        kind: 'error',
        message: t('workbench.local_model_test_failed_with_message', {
          defaultValue: '模型测试失败：{{message}}',
          message,
        }),
      })
    } finally {
      setTestingModel(false)
    }
  }

  const deleteModel = (model: LocalModelConfig) => {
    setError(null)
    try {
      deleteLocalModelConfig(model.id)
      if (editingId === model.id) resetForm()
    } catch (deleteError) {
      setError(
        getErrorMessage(deleteError, t('workbench.local_model_delete_failed', '删除模型失败'))
      )
    }
  }

  return (
    <section data-testid="model-interface-settings">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-text-primary">
            {t('workbench.model_interface_settings_title', '模型接口')}
          </h2>
          <p className="mt-1 text-sm leading-6 text-text-secondary">
            {t(
              'workbench.model_interface_settings_description',
              '管理任务可选择的本机接口和云端模型。'
            )}
          </p>
        </div>
        <button
          type="button"
          data-testid="local-model-add-button"
          onClick={() => runDiscardableAction({ kind: 'create' })}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-muted"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('workbench.local_model_add_action', '添加模型')}
        </button>
      </div>

      <div
        data-testid="local-model-settings"
        className="mt-4 grid gap-3 rounded-lg border border-border bg-background p-4"
      >
        {formVisible && (
          <form
            onSubmit={handleSubmit}
            className="grid gap-3 rounded-lg border border-border bg-background p-5"
          >
            <div className="grid items-start gap-3 sm:grid-cols-2">
              <label className="grid content-start gap-1.5 text-xs font-medium text-text-secondary">
                {t('workbench.local_model_url_label', '模型 URL')}
                <div
                  className={`${LOCAL_MODEL_COMPOUND_INPUT_CLASS} grid grid-cols-[minmax(0,1fr)_7rem]`}
                >
                  <input
                    data-testid="local-model-url-input"
                    value={form.baseUrl}
                    onChange={event => updateForm({ baseUrl: event.target.value })}
                    onPaste={handleBaseUrlPaste}
                    onBlur={normalizeBaseUrlInput}
                    placeholder="https://api.example.com/v1"
                    className={LOCAL_MODEL_SEGMENT_INPUT_CLASS}
                  />
                  <div className="grid min-w-0 grid-cols-[1px_minmax(0,1fr)]">
                    <span className="my-1.5 w-px bg-border" />
                    <input
                      aria-label={t('workbench.local_model_request_path_label', '请求路径')}
                      data-testid="local-model-request-path-input"
                      value={form.requestPath}
                      onChange={event => updateForm({ requestPath: event.target.value })}
                      onBlur={normalizeRequestPathInput}
                      placeholder={t(
                        'workbench.local_model_request_path_placeholder',
                        '/responses'
                      )}
                      className={LOCAL_MODEL_SEGMENT_INPUT_CLASS}
                    />
                  </div>
                </div>
                <span
                  data-testid="local-model-request-url"
                  className="break-all font-mono text-[11px] font-normal leading-5 text-text-muted"
                >
                  {testRequestUrl
                    ? t('workbench.local_model_request_url', {
                        defaultValue: '请求地址：{{url}}',
                        url: testRequestUrl,
                      })
                    : t(
                        'workbench.local_model_request_url_empty',
                        '填写模型基础地址和请求路径；粘贴完整地址时会自动拆分'
                      )}
                </span>
              </label>
              <label className="grid content-start gap-1.5 text-xs font-medium text-text-secondary">
                {t('workbench.local_model_id_label', '模型 ID')}
                <input
                  data-testid="local-model-id-input"
                  value={form.modelId}
                  onChange={event => updateForm({ modelId: event.target.value })}
                  placeholder="gpt-oss:20b"
                  className={LOCAL_MODEL_FIELD_CLASS}
                />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs font-medium text-text-secondary">
                {t('workbench.local_model_display_name_label', '显示名')}
                <input
                  data-testid="local-model-display-name-input"
                  value={form.displayName}
                  onChange={event => updateForm({ displayName: event.target.value })}
                  placeholder="Ollama GPT"
                  className={LOCAL_MODEL_FIELD_CLASS}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-text-secondary">
                {t('workbench.local_model_group_label', '分组')}
                <input
                  data-testid="local-model-group-input"
                  value={form.group}
                  onChange={event => updateForm({ group: event.target.value })}
                  placeholder={t('workbench.local_model_group_placeholder', '例如：本地推理')}
                  className={LOCAL_MODEL_FIELD_CLASS}
                />
              </label>
            </div>
            <div className="grid items-start gap-3 sm:grid-cols-2">
              <label className="grid content-start gap-1.5 text-xs font-medium text-text-secondary">
                {t('workbench.local_model_api_key_label', 'API Key')}
                <input
                  data-testid="local-model-api-key-input"
                  value={form.apiKey}
                  onChange={event => updateForm({ apiKey: event.target.value })}
                  placeholder={
                    editingModel?.apiKey
                      ? t('workbench.local_model_api_key_replace_placeholder', '留空则保留现有 Key')
                      : t('workbench.local_model_api_key_placeholder', '可选')
                  }
                  type="password"
                  className={LOCAL_MODEL_FIELD_CLASS}
                />
              </label>
              <label className="grid content-start gap-1.5 text-xs font-medium text-text-secondary">
                {t('workbench.local_model_context_window_label', 'Context window')}
                <input
                  data-testid="local-model-context-window-input"
                  value={form.contextWindow}
                  onChange={event => updateForm({ contextWindow: event.target.value })}
                  placeholder={t('workbench.local_model_context_window_placeholder', 'Optional')}
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  className={LOCAL_MODEL_FIELD_CLASS}
                />
                <span className="text-[11px] font-normal leading-5 text-text-muted">
                  {t(
                    'workbench.local_model_context_window_hint',
                    'Optional. Used to show remaining context and handle long conversations.'
                  )}
                </span>
              </label>
            </div>
            <div className="grid gap-3 border-t border-border pt-3">
              <div>
                <div className="text-xs font-semibold text-text-primary">
                  {t('workbench.local_model_codex_features_title')}
                </div>
                <div className="mt-1 text-[11px] leading-5 text-text-muted">
                  {t('workbench.local_model_codex_features_hint')}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1.5 text-xs font-medium text-text-secondary">
                  {t('workbench.local_model_web_search_label')}
                  <select
                    data-testid="local-model-web-search-select"
                    value={form.webSearchMode}
                    onChange={event =>
                      updateForm({
                        webSearchMode: event.target.value as LocalModelWebSearchMode,
                      })
                    }
                    className={LOCAL_MODEL_FIELD_CLASS}
                  >
                    {LOCAL_MODEL_WEB_SEARCH_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-text-secondary">
                  {t('workbench.local_model_image_generation_label')}
                  <select
                    data-testid="local-model-image-generation-select"
                    value={form.imageGenerationEnabled ? 'enabled' : 'disabled'}
                    onChange={event =>
                      updateForm({
                        imageGenerationEnabled: event.target.value === 'enabled',
                      })
                    }
                    className={LOCAL_MODEL_FIELD_CLASS}
                  >
                    {LOCAL_MODEL_IMAGE_GENERATION_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 text-sm text-text-secondary">
                <input
                  data-testid="local-model-enabled-checkbox"
                  type="checkbox"
                  checked={form.enabled}
                  onChange={event => updateForm({ enabled: event.target.checked })}
                  className="h-4 w-4 rounded border-border text-primary"
                />
                {t('workbench.local_model_enabled_label', '启用')}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {editingModel?.apiKey && (
                  <button
                    type="button"
                    data-testid="local-model-clear-api-key-button"
                    onClick={clearEditingApiKey}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
                  >
                    <X className="h-3.5 w-3.5" />
                    {t('workbench.local_model_clear_api_key_action', '清除 Key')}
                  </button>
                )}
                <button
                  type="button"
                  data-testid="local-model-test-button"
                  onClick={() => void handleTestModel()}
                  disabled={testingModel}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {testingModel ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5" />
                  )}
                  {testingModel
                    ? t('workbench.local_model_testing_action', '测试中')
                    : t('workbench.local_model_test_action', '测试')}
                </button>
                <button
                  type="button"
                  data-testid="local-model-cancel-edit-button"
                  onClick={() => runDiscardableAction({ kind: 'reset' })}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
                >
                  <X className="h-3.5 w-3.5" />
                  {t('common.cancel', '取消')}
                </button>
                <button
                  type="submit"
                  data-testid="local-model-save-button"
                  className="inline-flex h-8 items-center rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90"
                >
                  {editingId
                    ? t('workbench.local_model_update_action', '保存')
                    : t('workbench.local_model_save_action', '保存模型')}
                </button>
              </div>
            </div>
            {testResult && (
              <div
                data-testid="local-model-test-result"
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                  testResult.kind === 'success'
                    ? 'border-primary/20 bg-primary/10 text-primary'
                    : 'border-red-500/20 bg-red-500/10 text-red-500'
                }`}
              >
                {testResult.kind === 'success' ? (
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <span>{testResult.message}</span>
              </div>
            )}
          </form>
        )}

        {error && (
          <div
            data-testid="local-model-error"
            className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="grid gap-2">
          {models.map(model => (
            <div
              key={model.id}
              data-testid={`local-model-row-${model.id}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-sm font-semibold text-text-primary">
                    {model.displayName}
                  </h3>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      model.enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-text-muted'
                    }`}
                  >
                    {model.enabled
                      ? t('workbench.local_model_enabled', '已启用')
                      : t('workbench.local_model_disabled', '已停用')}
                  </span>
                  {model.apiKey && (
                    <span className="rounded-full bg-background px-2 py-0.5 text-xs text-text-muted">
                      {t('workbench.local_model_api_key_saved', '已保存 Key')}
                    </span>
                  )}
                  {model.group && (
                    <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                      {model.group}
                    </span>
                  )}
                  {model.contextWindow && (
                    <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                      {t('workbench.local_model_context_window_badge', {
                        defaultValue: 'Context: {{tokens}} tokens',
                        tokens: model.contextWindow.toLocaleString(),
                      })}
                    </span>
                  )}
                  <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                    {t('workbench.local_model_web_search_badge', {
                      mode: localModelWebSearchLabel(model.webSearchMode ?? 'disabled', t),
                    })}
                  </span>
                  <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                    {t('workbench.local_model_image_generation_badge', {
                      mode: localModelImageGenerationLabel(
                        model.imageGenerationEnabled === true,
                        t
                      ),
                    })}
                  </span>
                </div>
                <div className="mt-1 break-all font-mono text-xs text-text-secondary">
                  {model.modelId} · {model.baseUrl}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid={`local-model-edit-${model.id}`}
                  onClick={() => runDiscardableAction({ kind: 'edit', model })}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-background text-text-secondary hover:bg-muted hover:text-text-primary"
                  aria-label={t('workbench.local_model_edit_action', '编辑')}
                  title={t('workbench.local_model_edit_action', '编辑')}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  data-testid={`local-model-delete-${model.id}`}
                  onClick={() =>
                    editingId === model.id && formDirty
                      ? runDiscardableAction({ kind: 'delete', model })
                      : deleteModel(model)
                  }
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-background text-text-secondary hover:bg-red-500/10 hover:text-red-500"
                  aria-label={t('workbench.local_model_delete_action', '删除')}
                  title={t('workbench.local_model_delete_action', '删除')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
          {cloudConnection.isConnected ? (
            <CloudModelsSection cloudConnection={cloudConnection} />
          ) : (
            <DisconnectedCloudModelsSection onOpenCloudSettings={onOpenCloudSettings} />
          )}
        </div>
      </div>
      {pendingDiscardAction && (
        <LocalModelDiscardChangesDialog
          onCancel={cancelDiscardChanges}
          onConfirm={confirmDiscardChanges}
        />
      )}
    </section>
  )
}

function CloudModelsSection({
  cloudConnection,
}: {
  cloudConnection: CloudRuntimeSettingsConnection
}) {
  const { t } = useTranslation('common')
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!cloudConnection.isConnected) return undefined

    let cancelled = false
    Promise.resolve()
      .then(() => {
        if (cancelled) return null
        setLoading(true)
        setError(null)
        return createRuntimeSettingsApis(cloudConnection).modelApi.listModels()
      })
      .then(response => {
        if (!cancelled && response) setModels(response.data)
      })
      .catch(loadError => {
        if (!cancelled) {
          setError(
            getErrorMessage(loadError, t('workbench.cloud_models_error', '云端模型加载失败'))
          )
          setModels([])
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [cloudConnection, t])

  const cloudSummaryRow = (
    <div className="flex min-h-11 items-start gap-3 rounded-lg border border-border bg-background px-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-text-primary">
            {t('workbench.cloud_models_title', '云端模型')}
          </h3>
          {!loading && (
            <span className="rounded-full bg-background px-2 py-0.5 text-xs text-text-secondary">
              {models.length}
            </span>
          )}
        </div>
        <p className="mt-1 text-xs leading-5 text-text-secondary">
          {t('workbench.cloud_models_desc', '服务端模型会出现在工作台模型选择器里。')}
        </p>
      </div>
    </div>
  )

  return (
    <div data-testid="cloud-models-section" className="grid gap-2">
      {cloudSummaryRow}
      {loading ? (
        <div className="rounded-lg border border-border bg-background px-3 py-3 text-sm text-text-secondary">
          {t('workbench.cloud_models_loading', '正在加载云端模型...')}
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-3 text-sm text-red-500">
          {error}
        </div>
      ) : models.length === 0 ? (
        <div className="rounded-lg border border-border bg-background px-3 py-3 text-sm text-text-secondary">
          {t('workbench.cloud_models_empty', '暂无云端模型')}
        </div>
      ) : (
        <div className="grid gap-2">
          {models.slice(0, 8).map(model => (
            <div
              key={`${model.type}:${model.name}:${model.namespace ?? ''}`}
              className="flex min-h-11 items-center gap-3 rounded-lg border border-border bg-background px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text-primary">
                  {modelLabel(model)}
                </div>
                <div className="truncate text-xs text-text-secondary">
                  {modelMeta(model) || model.name}
                </div>
              </div>
              {model.isActive === false && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-text-muted">
                  {t('workbench.plugin_detail_disabled', '已停用')}
                </span>
              )}
            </div>
          ))}
          {models.length > 8 && (
            <div className="px-1 pt-1 text-xs text-text-secondary">
              {t('workbench.cloud_models_more', {
                defaultValue: '还有 {{count}} 个模型',
                count: models.length - 8,
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DisconnectedCloudModelsSection({
  onOpenCloudSettings,
}: {
  onOpenCloudSettings?: () => void
}) {
  const { t } = useTranslation('common')

  return (
    <div
      data-testid="cloud-models-section"
      className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-surface px-3 py-3 text-text-muted"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-text-secondary">
            {t('workbench.cloud_models_title', '云端模型')}
          </h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-text-muted">
            {t('workbench.runtime_config_cloud_disconnected', '未连接云端')}
          </span>
        </div>
        <p className="mt-1 text-xs leading-5 text-text-secondary">
          {t('workbench.cloud_models_disconnected_desc', '连接云端后查看服务端可用模型。')}
        </p>
      </div>
      {onOpenCloudSettings && (
        <button
          type="button"
          data-testid="cloud-models-configure-button"
          onClick={onOpenCloudSettings}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
        >
          <Network className="h-3.5 w-3.5" />
          {t('workbench.runtime_config_cloud_disabled_hint', '连接云端后可用')}
        </button>
      )}
    </div>
  )
}

function DisconnectedCloudCodexSyncSection({
  onOpenCloudSettings,
  status,
  loading,
  error,
  onRefresh,
  codexOfficialModels,
  codexOfficialLoading,
  codexOfficialError,
  onRefreshCodexOfficialModels,
}: {
  onOpenCloudSettings?: () => void
  status: LocalRuntimeAuthStatus | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  codexOfficialModels: CodexOfficialModelList | null
  codexOfficialLoading: boolean
  codexOfficialError: string | null
  onRefreshCodexOfficialModels: () => void
}) {
  const { t } = useTranslation('common')

  return (
    <>
      <CodexSettingsGroup title={t('workbench.codex_settings_models_group_title')}>
        <CodexOfficialModelsSection
          modelList={codexOfficialModels}
          loading={codexOfficialLoading}
          error={codexOfficialError}
          onRefresh={onRefreshCodexOfficialModels}
        />
      </CodexSettingsGroup>

      <CodexSettingsGroup title={t('workbench.codex_settings_auth_group_title')}>
        <LocalCodexModelRow status={status} loading={loading} error={error} onRefresh={onRefresh} />

        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-3 text-text-muted">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-text-secondary">
                {t('workbench.runtime_config_auth_file_title', '共享认证')}
              </h3>
              <span
                data-testid="runtime-config-status"
                className="rounded-full bg-muted px-2 py-0.5 text-xs text-text-muted"
              >
                {t('workbench.runtime_config_not_configured', '未配置')}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-text-secondary">
              {t('workbench.runtime_config_codex_description', '在不同设备之间同步CodeX认证信息。')}
            </p>
          </div>

          <div className="flex min-w-[320px] flex-wrap items-center justify-end gap-2">
            <select
              data-testid="runtime-config-sync-source-select"
              disabled
              className="h-8 w-[152px] cursor-not-allowed rounded-md border border-border bg-muted px-2 text-sm text-text-muted"
              aria-label={t('workbench.runtime_config_sync_source', '认证来源')}
            >
              <option value="">
                {t('workbench.runtime_config_current_device_source', '当前设备')}
              </option>
            </select>
            <button
              type="button"
              data-testid="runtime-config-sync-auth-button"
              onClick={onOpenCloudSettings}
              disabled={!onOpenCloudSettings}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Network className="h-3.5 w-3.5" />
              {t('workbench.runtime_config_cloud_disabled_hint', '连接云端后可用')}
            </button>
          </div>
        </div>
      </CodexSettingsGroup>
    </>
  )
}

function CodexSettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <h3 className="px-1 text-xs font-semibold text-text-secondary">{title}</h3>
      {children}
    </div>
  )
}

function ModelInterfaceSettingsSection({
  cloudConnection,
  onOpenCloudSettings,
}: {
  cloudConnection: CloudRuntimeSettingsConnection
  onOpenCloudSettings?: () => void
}) {
  return (
    <LocalModelSettingsSection
      cloudConnection={cloudConnection}
      onOpenCloudSettings={onOpenCloudSettings}
    />
  )
}

function CodexAuthSettingsSection({
  children,
  isConnected,
}: {
  children: React.ReactNode
  isConnected: boolean
}) {
  const { t } = useTranslation('common')

  return (
    <section data-testid="codex-auth-settings">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-text-primary">
              {t('workbench.codex_settings_title', 'Codex 设置')}
            </h2>
            {isConnected ? (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                {t('workbench.cloud_connection_status_connected', '已连接云端')}
              </span>
            ) : (
              <span
                data-testid="runtime-config-cloud-required"
                className="rounded-full bg-muted px-2 py-0.5 text-xs text-text-muted"
              >
                {t('workbench.runtime_config_cloud_disconnected', '未连接云端')}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm leading-6 text-text-secondary">
            {t('workbench.codex_settings_description', '管理当前设备 Codex 的认证和模型配置。')}
          </p>
        </div>
      </div>
      <div
        data-testid="runtime-config-cloud-sync"
        className="mt-4 grid gap-3 rounded-lg border border-border bg-background p-4"
      >
        {children}
      </div>
    </section>
  )
}

interface ModelSettingsPageProps {
  runtime?: UserRuntime
  onOpenCloudSettings?: () => void
}

export function ModelSettingsPage({
  runtime = 'codex',
  onOpenCloudSettings,
}: ModelSettingsPageProps) {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [config, setConfig] = useState<UserRuntimeConfig | null>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selectedAuthSyncSource, setSelectedAuthSyncSource] = useState('local')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [localAuthStatus, setLocalAuthStatus] = useState<LocalRuntimeAuthStatus | null>(null)
  const [localAuthLoading, setLocalAuthLoading] = useState(true)
  const [localAuthError, setLocalAuthError] = useState<string | null>(null)
  const [codexOfficialModels, setCodexOfficialModels] = useState<CodexOfficialModelList | null>(
    null
  )
  const [codexOfficialLoading, setCodexOfficialLoading] = useState(true)
  const [codexOfficialError, setCodexOfficialError] = useState<string | null>(null)

  const onlineDevices = useMemo(
    () => devices.filter(device => device.status === 'online' && isClaudeCodeDevice(device)),
    [devices]
  )
  const selectedImportDevice = useMemo(
    () =>
      selectedAuthSyncSource.startsWith('device:')
        ? (onlineDevices.find(device => `device:${device.device_id}` === selectedAuthSyncSource) ??
          null)
        : null,
    [onlineDevices, selectedAuthSyncSource]
  )
  const effectiveImportDeviceId = selectedImportDevice?.device_id ?? ''
  const selectedAuthSyncSourceIsLocal = selectedAuthSyncSource === 'local'
  const authSyncBusy = uploading || importing
  const canSyncAuthSource = selectedAuthSyncSourceIsLocal || Boolean(effectiveImportDeviceId)

  const loadLocalAuthStatus = useCallback(async () => {
    setLocalAuthLoading(true)
    setLocalAuthError(null)
    try {
      setLocalAuthStatus(await getLocalCodexAuthStatus())
    } catch (statusError) {
      setLocalAuthError(
        getErrorMessage(
          statusError,
          t('workbench.local_codex_auth_load_failed', '读取本机 Codex auth 状态失败')
        )
      )
    } finally {
      setLocalAuthLoading(false)
    }
  }, [t])

  useEffect(() => {
    void Promise.resolve().then(loadLocalAuthStatus)
  }, [loadLocalAuthStatus])

  const loadCodexOfficialModels = useCallback(async () => {
    setCodexOfficialLoading(true)
    setCodexOfficialError(null)
    try {
      const nextModels = await getLocalCodexOfficialModels()
      setCodexOfficialModels(nextModels)
      window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
    } catch (loadError) {
      setCodexOfficialModels(null)
      setCodexOfficialError(
        getErrorMessage(loadError, t('workbench.codex_official_models_load_failed'))
      )
    } finally {
      setCodexOfficialLoading(false)
    }
  }, [t])

  useEffect(() => {
    void Promise.resolve().then(loadCodexOfficialModels)
  }, [loadCodexOfficialModels])

  const loadRuntimeConfig = useCallback(
    async (refresh = false) => {
      if (!cloudConnection.isConnected) {
        setLoading(false)
        setRefreshing(false)
        return
      }
      if (refresh) {
        setRefreshing(true)
      } else {
        setLoading(true)
      }
      setError(null)
      try {
        const { deviceApi, userApi } = createRuntimeSettingsApis(cloudConnection)
        const [nextConfig, nextDevices] = await Promise.all([
          userApi.getRuntimeConfig(runtime),
          deviceApi.getAllDevices(),
        ])
        setConfig(nextConfig)
        setDevices(nextDevices.filter(isClaudeCodeDevice))
      } catch (loadError) {
        setError(
          getErrorMessage(
            loadError,
            t('workbench.runtime_config_load_failed', '加载运行时配置失败')
          )
        )
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [cloudConnection, runtime, t]
  )

  useEffect(() => {
    void Promise.resolve().then(() => loadRuntimeConfig())
  }, [loadRuntimeConfig])

  const handleToggleUseUserConfig = async () => {
    if (!config || !config.configured || updating) return
    setUpdating(true)
    setError(null)
    setNotice(null)
    try {
      const { userApi } = createRuntimeSettingsApis(cloudConnection)
      const nextConfig = await userApi.updateRuntimeConfig(runtime, {
        use_user_config: !config.use_user_config,
      })
      setConfig(nextConfig)
    } catch (updateError) {
      setError(
        getErrorMessage(
          updateError,
          t('workbench.runtime_config_save_failed', '保存运行时配置失败')
        )
      )
    } finally {
      setUpdating(false)
    }
  }

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return

    setUploading(true)
    setError(null)
    setNotice(null)
    try {
      const content = await file.text()
      validateAuthJsonContent(
        content,
        t('workbench.runtime_config_invalid_json', 'auth.json 必须是有效 JSON 对象')
      )
      const { userApi } = createRuntimeSettingsApis(cloudConnection)
      const nextConfig = await userApi.uploadRuntimeAuthJson(runtime, content)
      setConfig(nextConfig)
      setNotice(t('workbench.runtime_config_upload_success', 'auth.json 已保存'))
    } catch (uploadError) {
      setError(
        getErrorMessage(
          uploadError,
          t('workbench.runtime_config_upload_failed', '上传 auth.json 失败')
        )
      )
    } finally {
      setUploading(false)
    }
  }

  const handleImportFromDevice = async () => {
    if (!effectiveImportDeviceId || importing) return
    setImporting(true)
    setError(null)
    setNotice(null)
    try {
      const { userApi } = createRuntimeSettingsApis(cloudConnection)
      const nextConfig = await userApi.importRuntimeAuthJson(runtime, effectiveImportDeviceId)
      setConfig(nextConfig)
      setNotice(t('workbench.runtime_config_import_success', '已从设备导入 auth.json'))
    } catch (importError) {
      setError(
        getErrorMessage(importError, t('workbench.runtime_config_import_failed', '从设备导入失败'))
      )
    } finally {
      setImporting(false)
    }
  }

  const handleSyncAuthSource = () => {
    if (!canSyncAuthSource || authSyncBusy) return
    if (selectedAuthSyncSourceIsLocal) {
      fileInputRef.current?.click()
      return
    }
    void handleImportFromDevice()
  }

  const statusLabel = config?.configured
    ? t('workbench.runtime_config_configured', '已配置')
    : t('workbench.runtime_config_not_configured', '未配置')
  const statusClassName = config?.configured
    ? 'bg-primary/10 text-primary'
    : 'bg-muted text-text-muted'
  const updatedAt = formatRuntimeDate(config?.auth_json_updated_at)

  if (!cloudConnection.isConnected) {
    return (
      <div data-testid="model-settings-page" className="mx-auto w-full max-w-[820px]">
        <div>
          <h1 className="text-xl font-semibold tracking-normal text-text-primary">
            {t('workbench.model_settings_title', '模型设置')}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            {t('workbench.model_settings_subtitle', '管理模型接口和 Codex 设置。')}
          </p>
        </div>
        <div className="mt-8">
          <ModelInterfaceSettingsSection
            cloudConnection={cloudConnection}
            onOpenCloudSettings={onOpenCloudSettings}
          />
        </div>
        <div className="mt-8">
          <CodexAuthSettingsSection isConnected={false}>
            <DisconnectedCloudCodexSyncSection
              onOpenCloudSettings={onOpenCloudSettings}
              status={localAuthStatus}
              loading={localAuthLoading}
              error={localAuthError}
              onRefresh={() => void loadLocalAuthStatus()}
              codexOfficialModels={codexOfficialModels}
              codexOfficialLoading={codexOfficialLoading}
              codexOfficialError={codexOfficialError}
              onRefreshCodexOfficialModels={() => void loadCodexOfficialModels()}
            />
          </CodexAuthSettingsSection>
        </div>
      </div>
    )
  }

  return (
    <div data-testid="model-settings-page" className="mx-auto w-full max-w-[820px]">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-normal text-text-primary">
            {t('workbench.model_settings_title', '模型设置')}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            {t('workbench.model_settings_subtitle', '管理模型接口和 Codex 设置。')}
          </p>
        </div>
        <button
          type="button"
          data-testid="runtime-config-refresh-button"
          onClick={() => void loadRuntimeConfig(true)}
          disabled={loading || refreshing}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t('workbench.runtime_config_refresh', '刷新')}
          title={t('workbench.runtime_config_refresh', '刷新')}
        >
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </button>
      </div>

      <div className="mt-8">
        <ModelInterfaceSettingsSection
          cloudConnection={cloudConnection}
          onOpenCloudSettings={onOpenCloudSettings}
        />
      </div>

      <div className="mt-8">
        <CodexAuthSettingsSection isConnected>
          {loading ? (
            <div className="py-8 text-center text-sm text-text-secondary">
              {t('common.loading', '加载中...')}
            </div>
          ) : (
            <>
              <CodexSettingsGroup title={t('workbench.codex_settings_models_group_title')}>
                <CodexOfficialModelsSection
                  modelList={codexOfficialModels}
                  loading={codexOfficialLoading}
                  error={codexOfficialError}
                  onRefresh={() => void loadCodexOfficialModels()}
                />
              </CodexSettingsGroup>

              <CodexSettingsGroup title={t('workbench.codex_settings_auth_group_title')}>
                <LocalCodexModelRow
                  status={localAuthStatus}
                  loading={localAuthLoading}
                  error={localAuthError}
                  onRefresh={() => void loadLocalAuthStatus()}
                />

                <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-background px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-text-primary">
                        {t('workbench.runtime_config_auth_file_title', '共享认证')}
                      </h3>
                      <span
                        data-testid="runtime-config-status"
                        className={`rounded-full px-2 py-0.5 text-xs ${statusClassName}`}
                      >
                        {statusLabel}
                      </span>
                      <button
                        type="button"
                        data-testid="runtime-config-toggle"
                        role="switch"
                        aria-checked={config?.use_user_config ?? false}
                        onClick={handleToggleUseUserConfig}
                        disabled={!config?.configured || updating}
                        className={[
                          'inline-flex h-6 items-center justify-center gap-1 rounded-full px-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50',
                          config?.use_user_config
                            ? 'bg-primary text-white'
                            : 'bg-background text-text-secondary hover:bg-muted hover:text-text-primary',
                        ].join(' ')}
                      >
                        {updating && <Loader2 className="h-3 w-3 animate-spin" />}
                        {config?.use_user_config
                          ? t('workbench.runtime_config_use_enabled', '正在使用')
                          : t('workbench.runtime_config_use_disabled', '未启用')}
                      </button>
                    </div>
                    <div className="mt-1 break-all text-xs leading-5 text-text-secondary">
                      {config?.target_path ?? '~/.codex/auth.json'}
                      {updatedAt && (
                        <span className="ml-2">
                          {t('workbench.runtime_config_updated_at', '更新时间')}: {updatedAt}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      {config?.auth_json_sha256
                        ? `SHA-256 ${shortDigest(config.auth_json_sha256)}`
                        : t('workbench.runtime_config_secret_stored', '认证信息会加密保存。')}
                    </div>
                  </div>

                  <div className="flex min-w-[320px] flex-wrap items-center justify-end gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      data-testid="runtime-config-file-input"
                      accept="application/json,.json"
                      className="hidden"
                      onChange={event => void handleFileChange(event)}
                    />
                    <select
                      data-testid="runtime-config-sync-source-select"
                      value={selectedAuthSyncSource}
                      onChange={event => setSelectedAuthSyncSource(event.target.value)}
                      disabled={authSyncBusy}
                      className="h-8 w-[152px] rounded-md border border-border bg-background px-2 text-sm text-text-primary disabled:cursor-not-allowed disabled:bg-muted disabled:text-text-muted"
                      aria-label={t('workbench.runtime_config_sync_source', '认证来源')}
                    >
                      <option value="local">
                        {t('workbench.runtime_config_current_device_source', '当前设备')}
                      </option>
                      {onlineDevices.map(device => (
                        <option key={device.device_id} value={`device:${device.device_id}`}>
                          {device.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      data-testid="runtime-config-sync-auth-button"
                      onClick={handleSyncAuthSource}
                      disabled={!canSyncAuthSource || authSyncBusy}
                      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {authSyncBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Upload className="h-3.5 w-3.5" />
                      )}
                      {t('workbench.runtime_config_sync_action', '同步到其他设备')}
                    </button>
                  </div>
                </div>
              </CodexSettingsGroup>

              {notice && (
                <div
                  data-testid="runtime-config-notice"
                  className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-sm text-primary"
                >
                  {notice}
                </div>
              )}
              {error && (
                <div
                  data-testid="runtime-config-error"
                  className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </>
          )}
        </CodexAuthSettingsSection>
      </div>
    </div>
  )
}
