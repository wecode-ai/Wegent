import {
  AlertCircle,
  Download,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Upload,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { createUserApi } from '@/api/users'
import type { UserRuntimeConfig } from '@/api/users'
import { getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import { isClaudeCodeDevice } from '@/lib/device-capabilities'
import type { DeviceInfo } from '@/types/devices'

const CODEX_RUNTIME = 'codex'

function createRuntimeSettingsApis() {
  const { apiBaseUrl } = getRuntimeConfig()
  const client = createHttpClient({ baseUrl: apiBaseUrl })
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

export function RuntimeConfigSettingsPage() {
  const { t } = useTranslation('common')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [config, setConfig] = useState<UserRuntimeConfig | null>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selectedImportDeviceId, setSelectedImportDeviceId] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const onlineDevices = useMemo(
    () => devices.filter(device => device.status === 'online' && isClaudeCodeDevice(device)),
    [devices],
  )
  const selectedImportDevice = useMemo(
    () =>
      onlineDevices.find(device => device.device_id === selectedImportDeviceId) ??
      onlineDevices[0] ??
      null,
    [onlineDevices, selectedImportDeviceId],
  )
  const effectiveImportDeviceId = selectedImportDevice?.device_id ?? ''

  const loadRuntimeConfig = useCallback(async (refresh = false) => {
    if (refresh) {
      setRefreshing(true)
    } else {
      setLoading(true)
    }
    setError(null)
    try {
      const { deviceApi, userApi } = createRuntimeSettingsApis()
      const [nextConfig, nextDevices] = await Promise.all([
        userApi.getRuntimeConfig(CODEX_RUNTIME),
        deviceApi.getAllDevices(),
      ])
      setConfig(nextConfig)
      setDevices(nextDevices.filter(isClaudeCodeDevice))
    } catch (loadError) {
      setError(
        getErrorMessage(
          loadError,
          t('workbench.runtime_config_load_failed', '加载运行时配置失败'),
        ),
      )
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [t])

  useEffect(() => {
    void Promise.resolve().then(() => loadRuntimeConfig())
  }, [loadRuntimeConfig])

  const handleToggleUseUserConfig = async () => {
    if (!config || !config.configured || updating) return
    setUpdating(true)
    setError(null)
    setNotice(null)
    try {
      const { userApi } = createRuntimeSettingsApis()
      const nextConfig = await userApi.updateRuntimeConfig(CODEX_RUNTIME, {
        use_user_config: !config.use_user_config,
      })
      setConfig(nextConfig)
    } catch (updateError) {
      setError(
        getErrorMessage(
          updateError,
          t('workbench.runtime_config_save_failed', '保存运行时配置失败'),
        ),
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
        t('workbench.runtime_config_invalid_json', 'auth.json 必须是有效 JSON 对象'),
      )
      const { userApi } = createRuntimeSettingsApis()
      const nextConfig = await userApi.uploadRuntimeAuthJson(CODEX_RUNTIME, content)
      setConfig(nextConfig)
      setNotice(t('workbench.runtime_config_upload_success', 'auth.json 已保存'))
    } catch (uploadError) {
      setError(
        getErrorMessage(
          uploadError,
          t('workbench.runtime_config_upload_failed', '上传 auth.json 失败'),
        ),
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
      const { userApi } = createRuntimeSettingsApis()
      const nextConfig = await userApi.importRuntimeAuthJson(
        CODEX_RUNTIME,
        effectiveImportDeviceId,
      )
      setConfig(nextConfig)
      setNotice(t('workbench.runtime_config_import_success', '已从设备导入 auth.json'))
    } catch (importError) {
      setError(
        getErrorMessage(
          importError,
          t('workbench.runtime_config_import_failed', '从设备导入失败'),
        ),
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

  return (
    <div data-testid="runtime-config-settings-page" className="mx-auto w-full max-w-[820px]">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-normal text-text-primary">
            {t('workbench.runtime_config_title', 'Codex 认证')}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            {t('workbench.runtime_config_subtitle', '管理当前账号的 Codex auth.json')}
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
        {loading ? (
          <div className="py-8 text-center text-sm text-text-secondary">
            {t('common.loading', '加载中...')}
          </div>
        ) : (
          <section className="rounded-lg border border-border bg-background p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <KeyRound className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-text-primary">
                      {t('workbench.runtime_config_auth_file_title', '认证文件')}
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
                      '从设备导入或上传 Codex auth.json。启用后，使用 Codex 的 GPT 模型会通过该认证账户访问 Codex。',
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
                  {t('workbench.runtime_config_secret_stored', '认证信息会加密保存，不会在页面展示明文。')}
                </div>
                {config?.auth_json_sha256 && (
                  <div className="mt-1 font-mono text-xs text-text-secondary">
                    SHA-256 {shortDigest(config.auth_json_sha256)}
                  </div>
                )}
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
                    '从一台在线 Claude Code 设备读取 auth.json，系统校验后加密保存。',
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
                        {t('workbench.runtime_config_no_online_devices', '没有在线 Claude Code 设备')}
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
                  {t('workbench.runtime_config_upload_title', '上传认证文件')}
                </h3>
                <p className="mt-1 text-xs leading-5 text-text-secondary">
                  {t(
                    'workbench.runtime_config_upload_description',
                    '选择本机的 auth.json，系统会校验 JSON 后加密保存。',
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
                  {t('workbench.runtime_config_upload_action', '上传 auth.json')}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
