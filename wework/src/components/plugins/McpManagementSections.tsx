import type { ChangeEvent, FormEvent } from 'react'
import { useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  Download,
  FileJson,
  KeyRound,
  Loader2,
  Plus,
  Server,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  InstalledMCPServerConfig,
  MCPProviderInfo,
  MCPServer,
} from '@/types/api'
import { parseCustomMcpJson } from './mcp-json-import'

export interface CustomMcpFormState {
  name: string
  displayName: string
  description: string
  type: InstalledMCPServerConfig['type']
  url: string
  command: string
  args: string
  envJson: string
  headersJson: string
}

export function SectionHeading({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      <p className="mt-1 text-xs leading-5 text-text-muted">{description}</p>
    </div>
  )
}

export function CustomMcpForm({
  form,
  isSubmitting,
  onCancel,
  onChange,
  onSubmit,
}: {
  form: CustomMcpFormState
  isSubmitting: boolean
  onCancel: () => void
  onChange: (form: CustomMcpFormState) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const { t } = useTranslation('common')
  const jsonInputRef = useRef<HTMLInputElement | null>(null)
  const [jsonImportText, setJsonImportText] = useState('')
  const [jsonImportError, setJsonImportError] = useState<string | null>(null)
  const [isJsonImportOpen, setIsJsonImportOpen] = useState(false)
  const updateField = <Key extends keyof CustomMcpFormState,>(
    key: Key,
    value: CustomMcpFormState[Key],
  ) => onChange({ ...form, [key]: value })
  const applyJsonImport = (value: string) => {
    try {
      onChange({
        ...form,
        ...parseCustomMcpJson(value),
      })
      setJsonImportError(null)
      setJsonImportText('')
      setIsJsonImportOpen(false)
    } catch (error) {
      setJsonImportError(
        error instanceof Error
          ? error.message
          : t('workbench.plugins_custom_mcp_json_error', 'JSON 解析失败'),
      )
    }
  }
  const importJsonFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    applyJsonImport(await file.text())
  }

  return (
    <form
      className="rounded-2xl border border-border bg-surface p-5"
      onSubmit={onSubmit}
    >
      <div className="flex items-start justify-between gap-4">
        <SectionHeading
          title={t('workbench.plugins_custom_mcp_title', '创建自定义 MCP')}
          description={t(
            'workbench.plugins_custom_mcp_description',
            '保存用户自行配置的 MCP，创建后会进入已安装列表。',
          )}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="custom-mcp-import-json-button"
            className="flex h-9 items-center gap-2 rounded-xl bg-background px-3 text-sm font-semibold hover:bg-muted"
            onClick={() => setIsJsonImportOpen((previous) => !previous)}
          >
            <FileJson className="h-4 w-4" />
            {t('workbench.plugins_custom_mcp_import_json', '导入 JSON')}
          </button>
          <button
            type="button"
            aria-label={t('workbench.plugins_uninstall_cancel', '取消')}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted hover:bg-background"
            onClick={onCancel}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {isJsonImportOpen && (
        <div className="mt-5 rounded-2xl border border-border bg-background p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-text-secondary">
              {t(
                'workbench.plugins_custom_mcp_json_hint',
                '粘贴 mcpServers 或单个 MCP server JSON。',
              )}
            </p>
            <button
              type="button"
              className="h-8 rounded-lg bg-surface px-3 text-xs font-semibold hover:bg-muted"
              onClick={() => jsonInputRef.current?.click()}
            >
              {t('workbench.plugins_custom_mcp_json_file', '选择文件')}
            </button>
            <input
              ref={jsonInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              data-testid="custom-mcp-import-json-file-input"
              onChange={(event) => void importJsonFile(event)}
            />
          </div>
          <textarea
            value={jsonImportText}
            data-testid="custom-mcp-import-json-textarea"
            className="mt-3 h-28 w-full resize-none rounded-xl border border-border bg-surface p-3 font-mono text-xs outline-none focus:border-primary"
            onChange={(event) => setJsonImportText(event.target.value)}
          />
          {jsonImportError && (
            <div className="mt-2 flex items-center gap-2 text-xs font-semibold text-red-500">
              <AlertCircle className="h-4 w-4" />
              {jsonImportError}
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              data-testid="custom-mcp-apply-json-button"
              className="h-8 rounded-lg bg-text-primary px-3 text-xs font-semibold text-background hover:bg-text-primary/90 disabled:opacity-60"
              disabled={!jsonImportText.trim()}
              onClick={() => applyJsonImport(jsonImportText)}
            >
              {t('workbench.plugins_custom_mcp_apply_json', '应用')}
            </button>
          </div>
        </div>
      )}
      <div className="mt-5 grid grid-cols-2 gap-3">
        <McpTextInput
          label={t('workbench.plugins_custom_mcp_name', '名称')}
          value={form.name}
          testId="custom-mcp-name-input"
          onChange={(value) => updateField('name', value)}
        />
        <McpTextInput
          label={t('workbench.plugins_custom_mcp_display_name', '显示名称')}
          value={form.displayName}
          testId="custom-mcp-display-name-input"
          onChange={(value) => updateField('displayName', value)}
        />
        <label className="text-xs font-semibold text-text-secondary">
          {t('workbench.plugins_custom_mcp_type', '类型')}
          <select
            value={form.type}
            data-testid="custom-mcp-type-select"
            className="mt-2 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-primary"
            onChange={(event) =>
              updateField(
                'type',
                event.target.value as InstalledMCPServerConfig['type'],
              )
            }
          >
            <option value="streamable-http">streamable-http</option>
            <option value="sse">sse</option>
            <option value="http">http</option>
            <option value="stdio">stdio</option>
          </select>
        </label>
        <McpTextInput
          label={t('workbench.plugins_custom_mcp_description_label', '描述')}
          value={form.description}
          onChange={(value) => updateField('description', value)}
        />
        {form.type === 'stdio' ? (
          <>
            <McpTextInput
              label={t('workbench.plugins_custom_mcp_command', '命令')}
              value={form.command}
              testId="custom-mcp-command-input"
              onChange={(value) => updateField('command', value)}
            />
            <McpTextInput
              label={t('workbench.plugins_custom_mcp_args', '参数')}
              value={form.args}
              testId="custom-mcp-args-input"
              onChange={(value) => updateField('args', value)}
            />
            <div className="col-span-2">
              <McpTextarea
                label={t('workbench.plugins_custom_mcp_env', '环境变量 JSON')}
                value={form.envJson}
                testId="custom-mcp-env-input"
                onChange={(value) => updateField('envJson', value)}
              />
            </div>
          </>
        ) : (
          <>
            <McpTextInput
              label={t('workbench.plugins_custom_mcp_url', '服务地址')}
              value={form.url}
              testId="custom-mcp-url-input"
              onChange={(value) => updateField('url', value)}
            />
            <div className="col-span-2">
              <McpTextarea
                label={t('workbench.plugins_custom_mcp_headers', '请求头 JSON')}
                value={form.headersJson}
                testId="custom-mcp-headers-input"
                onChange={(value) => updateField('headersJson', value)}
              />
            </div>
          </>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          className="h-9 rounded-xl px-4 text-sm font-semibold text-text-secondary hover:bg-background"
          onClick={onCancel}
        >
          {t('workbench.plugins_uninstall_cancel', '取消')}
        </button>
        <button
          type="submit"
          data-testid="custom-mcp-submit-button"
          className="flex h-9 items-center gap-2 rounded-xl bg-text-primary px-4 text-sm font-semibold text-background hover:bg-text-primary/90 disabled:opacity-60"
          disabled={isSubmitting}
        >
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('workbench.plugins_custom_mcp_create', '创建')}
        </button>
      </div>
    </form>
  )
}

export function CustomMcpDialog({
  form,
  isSubmitting,
  onCancel,
  onChange,
  onSubmit,
}: {
  form: CustomMcpFormState
  isSubmitting: boolean
  onCancel: () => void
  onChange: (form: CustomMcpFormState) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/20 px-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Create custom MCP"
        className="w-full max-w-[620px]"
      >
        <CustomMcpForm
          form={form}
          isSubmitting={isSubmitting}
          onCancel={onCancel}
          onChange={onChange}
          onSubmit={onSubmit}
        />
      </section>
    </div>
  )
}

function McpTextInput({
  label,
  value,
  testId,
  onChange,
}: {
  label: string
  value: string
  testId?: string
  onChange: (value: string) => void
}) {
  return (
    <label className="text-xs font-semibold text-text-secondary">
      {label}
      <input
        value={value}
        data-testid={testId}
        className="mt-2 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-primary"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

function McpTextarea({
  label,
  value,
  testId,
  onChange,
}: {
  label: string
  value: string
  testId?: string
  onChange: (value: string) => void
}) {
  return (
    <label className="text-xs font-semibold text-text-secondary">
      {label}
      <textarea
        value={value}
        data-testid={testId}
        className="mt-2 h-20 w-full resize-none rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-primary"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

export function McpProviderBlock({
  provider,
  servers,
  error,
  tokenInput,
  isLoading,
  isSaving,
  onTokenChange,
  onSaveToken,
  onSync,
  onInstall,
}: {
  provider: MCPProviderInfo
  servers: MCPServer[]
  error?: string
  tokenInput: string
  isLoading: boolean
  isSaving: boolean
  onTokenChange: (value: string) => void
  onSaveToken: () => void
  onSync: () => void
  onInstall: (server: MCPServer) => void
}) {
  const { t } = useTranslation('common')
  const providerName = provider.name.trim() || provider.name_en?.trim() || provider.key

  return (
    <article className="rounded-2xl border border-border bg-background p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-surface text-primary">
              <Server className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold">
                {providerName}
              </h3>
              <p className="truncate text-xs text-text-muted">{provider.key}</p>
            </div>
          </div>
          <p className="mt-3 text-sm leading-6 text-text-secondary">
            {provider.description}
          </p>
        </div>
        <button
          type="button"
          data-testid={`mcp-provider-sync-${provider.key}`}
          className="flex h-9 shrink-0 items-center gap-2 rounded-xl bg-surface px-3 text-sm font-semibold hover:bg-muted disabled:opacity-60"
          disabled={
            isLoading || (provider.requires_token && !provider.has_token)
          }
          onClick={onSync}
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {t('workbench.plugins_mcp_sync', '同步')}
        </button>
      </div>

      {provider.requires_token && (
        <div className="mt-4 flex gap-2">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">
              {t('workbench.plugins_mcp_provider_token', '供应商 Token')}
            </span>
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              value={tokenInput}
              type="password"
              data-testid={`mcp-provider-token-${provider.key}`}
              placeholder={
                provider.has_token
                  ? t('workbench.plugins_mcp_token_configured', 'Token 已配置')
                  : t('workbench.plugins_mcp_provider_token', '供应商 Token')
              }
              className="h-10 w-full rounded-xl border border-border bg-surface pl-10 pr-3 text-sm outline-none focus:border-primary"
              onChange={(event) => onTokenChange(event.target.value)}
            />
          </label>
          <button
            type="button"
            data-testid={`mcp-provider-save-token-${provider.key}`}
            className="flex h-10 items-center gap-2 rounded-xl bg-text-primary px-4 text-sm font-semibold text-background hover:bg-text-primary/90 disabled:opacity-60"
            disabled={isSaving || !tokenInput.trim()}
            onClick={onSaveToken}
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            {t('workbench.plugins_mcp_save_token', '保存')}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm font-medium text-red-500">{error}</p>
      )}

      {servers.length > 0 && (
        <div className="mt-5 space-y-3">
          {servers.map((server) => (
            <McpProviderServerRow
              key={server.id}
              server={server}
              onInstall={() => onInstall(server)}
            />
          ))}
        </div>
      )}
    </article>
  )
}

function McpProviderServerRow({
  server,
  onInstall,
}: {
  server: MCPServer
  onInstall: () => void
}) {
  const { t } = useTranslation('common')
  const installed = server.installState === 'installed'

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-3 rounded-xl bg-surface px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h4 className="truncate text-sm font-semibold">{server.name}</h4>
          <span className="rounded-md bg-background px-2 py-0.5 text-xs font-semibold text-text-muted">
            {server.type}
          </span>
        </div>
        {server.description && (
          <p className="mt-1 truncate text-xs text-text-secondary">
            {server.description}
          </p>
        )}
      </div>
      {installed ? (
        <span className="flex h-8 items-center justify-center gap-1 rounded-lg bg-background text-xs font-semibold text-primary">
          <Check className="h-4 w-4" />
          {t('workbench.plugins_installed', '已安装')}
        </span>
      ) : (
        <button
          type="button"
          data-testid={`mcp-provider-install-${server.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
          className="flex h-8 items-center justify-center gap-1 rounded-lg bg-background text-xs font-semibold hover:bg-muted"
          onClick={onInstall}
        >
          <Plus className="h-4 w-4" />
          {t('workbench.plugins_install', '安装')}
        </button>
      )}
    </div>
  )
}
