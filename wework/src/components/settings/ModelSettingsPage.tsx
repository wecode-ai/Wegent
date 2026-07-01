import {
  AlertCircle,
  Download,
  KeyRound,
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
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { getLocalCodexAuthStatus, type LocalRuntimeAuthStatus } from '@/api/local/runtimeAuthStatus'
import { createUserApi } from '@/api/users'
import type { UserRuntime, UserRuntimeConfig } from '@/api/users'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { testLocalModelConnection } from '@/features/model-settings/localModelConnectionTest'
import {
  deleteLocalModelConfig,
  listLocalModelConfigs,
  LOCAL_MODEL_SETTINGS_CHANGED_EVENT,
  saveLocalModelConfig,
  type LocalModelConfig,
} from '@/features/model-settings/localModelSettings'
import { useTranslation } from '@/hooks/useTranslation'
import { isClaudeCodeDevice } from '@/lib/device-capabilities'
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
      className="rounded-lg border border-border bg-surface px-3 py-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-text-secondary">
            <KeyRound className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-text-primary">
                {t('workbench.local_codex_model_title', '本机 Codex')}
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
            <p className="mt-1 text-xs leading-5 text-text-secondary">
              {t(
                'workbench.local_codex_model_description',
                '使用本机 ~/.codex/auth.json，在本机 device 上运行。'
              )}
            </p>
          </div>
        </div>
        <button
          type="button"
          data-testid="local-codex-auth-refresh-button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-surface text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t('workbench.runtime_config_refresh', '刷新')}
          title={t('workbench.runtime_config_refresh', '刷新')}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </button>
      </div>
      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-md bg-background px-3 py-2">
          <div className="text-xs text-text-muted">
            {t('workbench.runtime_config_target_path', '目标路径')}
          </div>
          <div className="mt-1 break-all font-mono text-xs text-text-primary">
            {t('workbench.local_codex_auth_path_value', {
              defaultValue: '本机 {{path}}',
              path: status?.targetPath ?? '~/.codex/auth.json',
            })}
          </div>
        </div>
        <div className="rounded-md bg-background px-3 py-2">
          <div className="text-xs text-text-muted">
            {t('workbench.runtime_config_updated_at', '更新时间')}
          </div>
          <div className="mt-1 text-xs text-text-primary">
            {formatRuntimeDate(status?.updatedAt) ||
              t('workbench.runtime_config_never_updated', '从未更新')}
          </div>
        </div>
        <div className="rounded-md bg-background px-3 py-2 sm:col-span-2">
          <div className="flex items-center gap-1.5 text-xs text-text-muted">
            <ShieldCheck className="h-3.5 w-3.5" />
            {status?.sha256
              ? `SHA-256 ${shortDigest(status.sha256)}`
              : t('workbench.local_codex_auth_no_digest', '没有可显示的摘要')}
          </div>
          {error && <div className="mt-1 text-xs text-red-500">{error}</div>}
        </div>
      </div>
    </div>
  )
}

interface LocalModelFormState {
  displayName: string
  modelId: string
  baseUrl: string
  apiKey: string
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

const EMPTY_LOCAL_MODEL_FORM: LocalModelFormState = {
  displayName: '',
  modelId: '',
  baseUrl: '',
  apiKey: '',
  enabled: true,
}

interface LocalCodexModelRowProps {
  status: LocalRuntimeAuthStatus | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}

function LocalModelSettingsSection(localCodexModel: LocalCodexModelRowProps) {
  const { t } = useTranslation('common')
  const [models, setModels] = useState<LocalModelConfig[]>(() => listLocalModelConfigs())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formVisible, setFormVisible] = useState(false)
  const [form, setForm] = useState<LocalModelFormState>(EMPTY_LOCAL_MODEL_FORM)
  const [error, setError] = useState<string | null>(null)
  const [testingModel, setTestingModel] = useState(false)
  const [testResult, setTestResult] = useState<LocalModelTestResult | null>(null)

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

  const resetForm = () => {
    setEditingId(null)
    setFormVisible(false)
    setForm(EMPTY_LOCAL_MODEL_FORM)
    setError(null)
    setTestResult(null)
  }

  const startCreating = () => {
    setEditingId(null)
    setFormVisible(true)
    setForm(EMPTY_LOCAL_MODEL_FORM)
    setError(null)
    setTestResult(null)
  }

  const startEditing = (model: LocalModelConfig) => {
    setEditingId(model.id)
    setFormVisible(true)
    setForm({
      displayName: model.displayName,
      modelId: model.modelId,
      baseUrl: model.baseUrl,
      apiKey: '',
      enabled: model.enabled,
    })
    setError(null)
    setTestResult(null)
  }

  const updateForm = (patch: Partial<LocalModelFormState>) => {
    setForm(current => ({ ...current, ...patch }))
    setTestResult(null)
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    try {
      saveLocalModelConfig({
        id: editingId,
        displayName: form.displayName,
        modelId: form.modelId,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey.trim() ? form.apiKey : editingModel?.apiKey,
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
        modelId: editingModel.modelId,
        baseUrl: editingModel.baseUrl,
        apiKey: null,
        enabled: editingModel.enabled,
      })
      startEditing({ ...editingModel, apiKey: undefined })
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

  return (
    <section
      data-testid="local-model-settings"
      className="rounded-lg border border-border bg-background p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">
            {t('workbench.local_model_settings_title', '本机模型')}
          </h2>
          <p className="mt-1 text-sm leading-6 text-text-secondary">
            {t(
              'workbench.local_model_settings_description',
              '管理本机 Codex 和其他 OpenAI Responses 兼容模型。'
            )}
          </p>
        </div>
        <button
          type="button"
          data-testid="local-model-add-button"
          onClick={startCreating}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium text-text-primary hover:bg-muted"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('workbench.local_model_add_action', '添加模型')}
        </button>
      </div>

      {formVisible && (
        <form onSubmit={handleSubmit} className="mt-5 grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-medium text-text-secondary">
              {t('workbench.local_model_url_label', '模型 URL')}
              <input
                data-testid="local-model-url-input"
                value={form.baseUrl}
                onChange={event => updateForm({ baseUrl: event.target.value })}
                placeholder="http://localhost:11434/v1"
                className="h-9 rounded-md border border-border bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-text-secondary">
              {t('workbench.local_model_id_label', '模型 ID')}
              <input
                data-testid="local-model-id-input"
                value={form.modelId}
                onChange={event => updateForm({ modelId: event.target.value })}
                placeholder="gpt-oss:20b"
                className="h-9 rounded-md border border-border bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary"
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
                className="h-9 rounded-md border border-border bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-text-secondary">
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
                className="h-9 rounded-md border border-border bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary"
              />
            </label>
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
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
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
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
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
                onClick={resetForm}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
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

      <div className="mt-5 grid gap-2">
        <LocalCodexModelRow {...localCodexModel} />
        {models.map(model => (
          <div
            key={model.id}
            data-testid={`local-model-row-${model.id}`}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-3"
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
              </div>
              <div className="mt-1 break-all font-mono text-xs text-text-secondary">
                {model.modelId} · {model.baseUrl}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid={`local-model-edit-${model.id}`}
                onClick={() => startEditing(model)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-background text-text-secondary hover:bg-muted hover:text-text-primary"
                aria-label={t('workbench.local_model_edit_action', '编辑')}
                title={t('workbench.local_model_edit_action', '编辑')}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                data-testid={`local-model-delete-${model.id}`}
                onClick={() => {
                  setError(null)
                  try {
                    deleteLocalModelConfig(model.id)
                    if (editingId === model.id) resetForm()
                  } catch (deleteError) {
                    setError(
                      getErrorMessage(
                        deleteError,
                        t('workbench.local_model_delete_failed', '删除模型失败')
                      )
                    )
                  }
                }}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-background text-text-secondary hover:bg-red-500/10 hover:text-red-500"
                aria-label={t('workbench.local_model_delete_action', '删除')}
                title={t('workbench.local_model_delete_action', '删除')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function DisconnectedCloudCodexSyncSection() {
  const { t } = useTranslation('common')

  return (
    <section
      data-testid="runtime-config-cloud-sync"
      className="rounded-lg border border-dashed border-border bg-surface p-5 opacity-70"
      aria-disabled="true"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background text-text-secondary">
            <KeyRound className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-text-primary">
                {t('workbench.runtime_config_cloud_sync_title', '云端 Codex 同步')}
              </h2>
              <span
                data-testid="runtime-config-cloud-required"
                className="rounded-full bg-muted px-2 py-0.5 text-xs text-text-muted"
              >
                {t('workbench.runtime_config_cloud_disconnected', '未连接云端')}
              </span>
            </div>
            <p className="mt-1 text-sm leading-6 text-text-secondary">
              {t(
                'workbench.runtime_config_cloud_sync_description',
                '连接云端后，可以把本机 Codex auth.json 同步到云端设备，或从在线设备导入一份云端 Codex 模型。'
              )}
            </p>
          </div>
        </div>
        <button
          type="button"
          data-testid="runtime-config-toggle"
          role="switch"
          aria-checked={false}
          disabled
          className="inline-flex h-8 min-w-[112px] cursor-not-allowed items-center justify-center rounded-full bg-background px-3 text-sm font-medium text-text-muted"
        >
          {t('workbench.runtime_config_cloud_disabled_hint', '连接云端后可用')}
        </button>
      </div>

      <div className="mt-5 rounded-lg border border-border bg-background p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
              <Network className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-text-primary">
                {t('workbench.runtime_config_proxy_title')}
              </h3>
              <p className="mt-1 text-xs leading-5 text-text-secondary">
                {t('workbench.runtime_config_proxy_description')}
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="runtime-config-proxy-toggle"
            role="switch"
            aria-checked={false}
            disabled
            className="inline-flex h-8 min-w-[112px] cursor-not-allowed items-center justify-center rounded-full bg-surface px-3 text-sm font-medium text-text-muted"
          >
            {t('workbench.runtime_config_cloud_disabled_hint', '连接云端后可用')}
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-[1.5fr_1fr]">
        <div className="rounded-lg border border-border bg-background p-3">
          <h3 className="text-sm font-semibold text-text-primary">
            {t('workbench.runtime_config_device_title', '从设备导入')}
          </h3>
          <p className="mt-1 text-xs leading-5 text-text-secondary">
            {t(
              'workbench.runtime_config_device_description',
              '从一台在线设备读取 auth.json，并保存为云端 Codex 模型。'
            )}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <select
              data-testid="runtime-config-import-device-select"
              disabled
              className="h-8 min-w-0 flex-1 cursor-not-allowed rounded-md border border-border bg-surface px-2 text-sm text-text-muted"
              aria-label={t('workbench.runtime_config_import_device', '选择导入设备')}
            >
              <option value="">
                {t('workbench.runtime_config_cloud_disabled_hint', '连接云端后可用')}
              </option>
            </select>
            <button
              type="button"
              data-testid="runtime-config-import-button"
              disabled
              className="inline-flex h-8 cursor-not-allowed items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium text-text-muted"
            >
              <Download className="h-3.5 w-3.5" />
              {t('workbench.runtime_config_import_action', '从设备导入')}
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-background p-3">
          <h3 className="text-sm font-semibold text-text-primary">
            {t('workbench.runtime_config_upload_title', '同步本机 Codex')}
          </h3>
          <p className="mt-1 text-xs leading-5 text-text-secondary">
            {t(
              'workbench.runtime_config_upload_description',
              '选择本机 auth.json，保存到服务端后可供云端设备使用。'
            )}
          </p>
          <button
            type="button"
            data-testid="runtime-config-upload-button"
            disabled
            className="mt-3 inline-flex h-8 cursor-not-allowed items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background opacity-60"
          >
            <Upload className="h-3.5 w-3.5" />
            {t('workbench.runtime_config_upload_action', '同步本机 Codex')}
          </button>
        </div>
      </div>
    </section>
  )
}

interface ModelSettingsPageProps {
  runtime?: UserRuntime
}

export function ModelSettingsPage({ runtime = 'codex' }: ModelSettingsPageProps) {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [config, setConfig] = useState<UserRuntimeConfig | null>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selectedImportDeviceId, setSelectedImportDeviceId] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [proxyUpdating, setProxyUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [localAuthStatus, setLocalAuthStatus] = useState<LocalRuntimeAuthStatus | null>(null)
  const [localAuthLoading, setLocalAuthLoading] = useState(true)
  const [localAuthError, setLocalAuthError] = useState<string | null>(null)

  const onlineDevices = useMemo(
    () => devices.filter(device => device.status === 'online' && isClaudeCodeDevice(device)),
    [devices]
  )
  const selectedImportDevice = useMemo(
    () =>
      onlineDevices.find(device => device.device_id === selectedImportDeviceId) ??
      onlineDevices[0] ??
      null,
    [onlineDevices, selectedImportDeviceId]
  )
  const effectiveImportDeviceId = selectedImportDevice?.device_id ?? ''

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

  const handleToggleUseProxy = async () => {
    if (!config || proxyUpdating) return
    if (!config.use_proxy && !config.proxy_configured) {
      setError(t('workbench.runtime_config_proxy_required'))
      return
    }

    setProxyUpdating(true)
    setError(null)
    setNotice(null)
    try {
      const { userApi } = createRuntimeSettingsApis(cloudConnection)
      const nextConfig = await userApi.updateRuntimeConfig(runtime, {
        use_user_config: config.use_user_config,
        use_proxy: !config.use_proxy,
      })
      setConfig(nextConfig)
    } catch (proxyError) {
      setError(getErrorMessage(proxyError, t('workbench.runtime_config_proxy_toggle_failed')))
    } finally {
      setProxyUpdating(false)
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

  const statusLabel = config?.configured
    ? t('workbench.runtime_config_configured', '已配置')
    : t('workbench.runtime_config_not_configured', '未配置')
  const statusClassName = config?.configured
    ? 'bg-primary/10 text-primary'
    : 'bg-muted text-text-muted'
  const updatedAt = formatRuntimeDate(config?.auth_json_updated_at)
  const activeDeviceName = selectedImportDevice?.name

  if (!cloudConnection.isConnected) {
    return (
      <div data-testid="model-settings-page" className="mx-auto w-full max-w-[820px]">
        <div>
          <h1 className="text-xl font-semibold tracking-normal text-text-primary">
            {t('workbench.model_settings_title', '模型设置')}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            {t('workbench.model_settings_subtitle', '管理本机模型、本机 Codex 和云端 Codex 同步。')}
          </p>
        </div>
        <div className="mt-8">
          <LocalModelSettingsSection
            status={localAuthStatus}
            loading={localAuthLoading}
            error={localAuthError}
            onRefresh={() => void loadLocalAuthStatus()}
          />
        </div>
        <div className="mt-4">
          <DisconnectedCloudCodexSyncSection />
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
            {t('workbench.model_settings_subtitle', '管理本机模型、本机 Codex 和云端 Codex 同步。')}
          </p>
        </div>
        <button
          type="button"
          data-testid="runtime-config-refresh-button"
          onClick={() => void loadRuntimeConfig(true)}
          disabled={loading || refreshing}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-surface text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
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
        <LocalModelSettingsSection
          status={localAuthStatus}
          loading={localAuthLoading}
          error={localAuthError}
          onRefresh={() => void loadLocalAuthStatus()}
        />
      </div>

      <div className="mt-8">
        {loading ? (
          <div className="py-8 text-center text-sm text-text-secondary">
            {t('common.loading', '加载中...')}
          </div>
        ) : (
          <section
            data-testid="runtime-config-cloud-sync"
            className="rounded-lg border border-border bg-background p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <KeyRound className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-text-primary">
                      {t('workbench.runtime_config_auth_file_title', '云端 Codex 模型')}
                    </h2>
                    <span
                      data-testid="runtime-config-status"
                      className={`rounded-full px-2 py-0.5 text-xs ${statusClassName}`}
                    >
                      {statusLabel}
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-text-secondary">
                    {t(
                      'workbench.runtime_config_codex_description',
                      '把本机 Codex auth.json 保存到服务端后，云端设备可以使用这份 Codex 模型。'
                    )}
                  </p>
                </div>
              </div>
              <button
                type="button"
                data-testid="runtime-config-toggle"
                role="switch"
                aria-checked={config?.use_user_config ?? false}
                onClick={handleToggleUseUserConfig}
                disabled={!config?.configured || updating}
                className={[
                  'inline-flex h-8 min-w-[112px] items-center justify-center gap-2 rounded-full px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50',
                  config?.use_user_config
                    ? 'bg-primary text-white'
                    : 'bg-surface text-text-secondary hover:bg-muted hover:text-text-primary',
                ].join(' ')}
              >
                {updating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {config?.use_user_config
                  ? t('workbench.runtime_config_use_enabled', '正在使用')
                  : t('workbench.runtime_config_use_disabled', '未启用')}
              </button>
            </div>

            <div className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-lg bg-surface px-3 py-2">
                <div className="text-xs text-text-muted">
                  {t('workbench.runtime_config_target_path', '目标路径')}
                </div>
                <div className="mt-1 font-mono text-xs text-text-primary">
                  {config?.target_path ?? '~/.codex/auth.json'}
                </div>
              </div>
              <div className="rounded-lg bg-surface px-3 py-2">
                <div className="text-xs text-text-muted">
                  {t('workbench.runtime_config_updated_at', '更新时间')}
                </div>
                <div className="mt-1 text-xs text-text-primary">
                  {updatedAt || t('workbench.runtime_config_never_updated', '从未更新')}
                </div>
              </div>
              <div className="rounded-lg bg-surface px-3 py-2 sm:col-span-2">
                <div className="flex items-center gap-1.5 text-xs text-text-muted">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {t(
                    'workbench.runtime_config_secret_stored',
                    '认证信息会加密保存，页面只显示状态和摘要。'
                  )}
                </div>
                {config?.auth_json_sha256 && (
                  <div className="mt-1 font-mono text-xs text-text-secondary">
                    SHA-256 {shortDigest(config.auth_json_sha256)}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-5 rounded-lg border border-border bg-surface p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-text-secondary">
                    <Network className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-text-primary">
                      {t('workbench.runtime_config_proxy_title')}
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-text-secondary">
                      {t('workbench.runtime_config_proxy_description')}
                    </p>
                    {config?.proxy_configured ? (
                      <div className="mt-2 text-xs text-text-secondary">
                        {t('workbench.runtime_config_proxy_configured', {
                          proxy: config.proxy_url_masked,
                        })}
                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-text-muted">
                        {t('workbench.runtime_config_proxy_not_configured')}
                      </div>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="runtime-config-proxy-toggle"
                  role="switch"
                  aria-checked={config?.use_proxy ?? false}
                  onClick={handleToggleUseProxy}
                  disabled={proxyUpdating || (!config?.proxy_configured && !config?.use_proxy)}
                  className={[
                    'inline-flex h-8 min-w-[112px] items-center justify-center gap-2 rounded-full px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50',
                    config?.use_proxy
                      ? 'bg-primary text-white'
                      : 'bg-background text-text-secondary hover:bg-muted hover:text-text-primary',
                  ].join(' ')}
                >
                  {proxyUpdating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {config?.use_proxy
                    ? t('workbench.runtime_config_proxy_enabled')
                    : t('workbench.runtime_config_proxy_disabled')}
                </button>
              </div>
            </div>

            {notice && (
              <div
                data-testid="runtime-config-notice"
                className="mt-4 rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-sm text-primary"
              >
                {notice}
              </div>
            )}
            {error && (
              <div
                data-testid="runtime-config-error"
                className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="mt-6 grid gap-3 lg:grid-cols-[1.5fr_1fr]">
              <div className="rounded-lg border border-border bg-surface p-3">
                <h3 className="text-sm font-semibold text-text-primary">
                  {t('workbench.runtime_config_device_title', '从设备导入')}
                </h3>
                <p className="mt-1 text-xs leading-5 text-text-secondary">
                  {t(
                    'workbench.runtime_config_device_description',
                    '从一台在线设备读取 auth.json，并保存为云端 Codex 模型。'
                  )}
                </p>

                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <select
                    data-testid="runtime-config-import-device-select"
                    value={effectiveImportDeviceId}
                    onChange={event => setSelectedImportDeviceId(event.target.value)}
                    disabled={onlineDevices.length === 0 || importing}
                    className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={t('workbench.runtime_config_import_device', '选择导入设备')}
                  >
                    {onlineDevices.length === 0 ? (
                      <option value="">
                        {t('workbench.runtime_config_no_online_devices', '没有在线 Codex 设备')}
                      </option>
                    ) : (
                      onlineDevices.map(device => (
                        <option key={device.device_id} value={device.device_id}>
                          {device.name}
                        </option>
                      ))
                    )}
                  </select>
                  <button
                    type="button"
                    data-testid="runtime-config-import-button"
                    onClick={() => void handleImportFromDevice()}
                    disabled={!effectiveImportDeviceId || importing}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {importing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {t('workbench.runtime_config_import_action', '从设备导入')}
                  </button>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-text-muted">
                    {activeDeviceName
                      ? t('workbench.runtime_config_selected_device', {
                          defaultValue: '当前选择：{{name}}',
                          name: activeDeviceName,
                        })
                      : t('workbench.runtime_config_online_count', {
                          defaultValue: '{{count}} 台在线设备',
                          count: onlineDevices.length,
                        })}
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-surface p-3">
                <h3 className="text-sm font-semibold text-text-primary">
                  {t('workbench.runtime_config_upload_title', '同步本机 Codex')}
                </h3>
                <p className="mt-1 text-xs leading-5 text-text-secondary">
                  {t(
                    'workbench.runtime_config_upload_description',
                    '选择本机 auth.json，保存到服务端后可供云端设备使用。'
                  )}
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  data-testid="runtime-config-file-input"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={event => void handleFileChange(event)}
                />
                <button
                  type="button"
                  data-testid="runtime-config-upload-button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {uploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                  {t('workbench.runtime_config_upload_action', '同步本机 Codex')}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
