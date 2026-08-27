import { AlertTriangle, Archive, CheckCircle2, Download, Loader2, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  LocalCodexPluginApi,
  LocalPluginImportCompletion,
  LocalPluginImportIssue,
  LocalPluginImportPreview,
} from '@/api/local/codexPlugins'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { useTranslation } from '@/hooks/useTranslation'

function issueGuidance(
  issue: LocalPluginImportIssue,
  t: ReturnType<typeof useTranslation>['t']
): string {
  const guidance: Record<string, string> = {
    manifest_not_at_root: t(
      'workbench.plugins_import_issue_manifest_not_at_root',
      'ZIP 多包了一层目录。请进入插件目录后压缩其中的内容，确保 .codex-plugin/plugin.json 位于 ZIP 根目录。'
    ),
    manifest_missing: t(
      'workbench.plugins_import_issue_manifest_missing',
      '这不是标准 Wework 插件包。Skill 和 MCP 也需要先放入插件目录，并在 ZIP 根目录提供 .codex-plugin/plugin.json。'
    ),
    manifest_version_invalid: t(
      'workbench.plugins_import_issue_version',
      '请把 plugin.json 的 version 改为 SemVer，例如 0.1.0。'
    ),
    manifest_name_invalid: t(
      'workbench.plugins_import_issue_name',
      'plugin.json 的 name 应使用小写字母、数字、连字符或下划线，例如 my-plugin。'
    ),
    manifest_description_missing: t(
      'workbench.plugins_import_issue_manifest_fields',
      '请参照示例包补齐 plugin.json 中标出的必填字段。'
    ),
    manifest_author_missing: t(
      'workbench.plugins_import_issue_manifest_fields',
      '请参照示例包补齐 plugin.json 中标出的必填字段。'
    ),
    manifest_interface_incomplete: t(
      'workbench.plugins_import_issue_manifest_fields',
      '请参照示例包补齐 plugin.json 中标出的必填字段。'
    ),
    manifest_capabilities_invalid: t(
      'workbench.plugins_import_issue_manifest_fields',
      '请参照示例包补齐 plugin.json 中标出的必填字段。'
    ),
    manifest_default_prompt_missing: t(
      'workbench.plugins_import_issue_manifest_fields',
      '请参照示例包补齐 plugin.json 中标出的必填字段。'
    ),
    skills_path_invalid: t(
      'workbench.plugins_import_issue_skills',
      'skills 字段应为 ./skills/，并确保对应目录存在。'
    ),
    mcp_manifest_invalid: t(
      'workbench.plugins_import_issue_mcp',
      '.mcp.json 必须是合法的 MCP server map，或包含 mcp_servers / mcpServers 对象。'
    ),
    mcp_path_invalid: t(
      'workbench.plugins_import_issue_mcp',
      '.mcp.json 必须是合法的 MCP server map，或包含 mcp_servers / mcpServers 对象。'
    ),
    skill_manifest_invalid: t(
      'workbench.plugins_import_issue_skill_manifest',
      '每个 Skill 目录都需要一个 SKILL.md，并以包含 name 和 description 的 YAML frontmatter 开头。'
    ),
    skill_frontmatter_incomplete: t(
      'workbench.plugins_import_issue_skill_manifest',
      '每个 Skill 目录都需要一个 SKILL.md，并以包含 name 和 description 的 YAML frontmatter 开头。'
    ),
    interface_asset_missing: t(
      'workbench.plugins_import_issue_asset',
      'plugin.json 引用了不存在的图标资源，请补充文件或移除对应字段。'
    ),
    zip_invalid: t(
      'workbench.plugins_import_issue_zip',
      '文件不是有效 ZIP，请下载示例包并按相同目录结构重新压缩。'
    ),
    archive_limit_exceeded: t(
      'workbench.plugins_import_issue_limit',
      '插件包超出限制：ZIP 不超过 50 MB、解压后不超过 200 MB，且文件数不超过 5000。'
    ),
    archive_encrypted: t(
      'workbench.plugins_import_issue_encrypted',
      '插件 ZIP 已加密，暂不支持需要密码的压缩包。请解压后重新创建一个不加密的 ZIP。'
    ),
    archive_unsafe: t(
      'workbench.plugins_import_issue_unsafe',
      '压缩包包含不安全路径、符号链接或重复文件，请重新打包。'
    ),
    manifest_invalid: t(
      'workbench.plugins_import_issue_json',
      '.codex-plugin/plugin.json 不是合法 JSON，请修正语法后重试。'
    ),
    package_invalid: t(
      'workbench.plugins_import_issue_unknown',
      '无法读取插件包。请下载示例包，对照目录结构重新打包后再试。'
    ),
  }
  return (
    guidance[issue.code] ??
    t(
      'workbench.plugins_import_issue_unknown',
      '无法读取插件包。请下载示例包，对照目录结构重新打包后再试。'
    )
  )
}

function previewErrorGuidance(error: unknown, t: ReturnType<typeof useTranslation>['t']): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/password|decrypt|encrypted/i.test(message)) {
    return t(
      'workbench.plugins_import_issue_encrypted',
      '插件 ZIP 已加密，暂不支持需要密码的压缩包。请解压后重新创建一个不加密的 ZIP。'
    )
  }
  if (/50 MB|200 MB|entries/i.test(message)) {
    return t(
      'workbench.plugins_import_issue_limit',
      '插件包超出限制：ZIP 不超过 50 MB、解压后不超过 200 MB，且文件数不超过 5000。'
    )
  }
  return t('workbench.plugins_import_preview_failed', '无法读取插件包，请确认文件为标准 ZIP。')
}

function importErrorGuidance(error: unknown, t: ReturnType<typeof useTranslation>['t']): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/changed after preview/i.test(message)) {
    return t(
      'workbench.plugins_import_file_changed',
      '插件 ZIP 在检查后发生了变化，请重新选择文件。'
    )
  }
  if (/already exists/i.test(message)) {
    return t(
      'workbench.plugins_import_already_exists',
      '同名插件已存在，请重新选择插件包并确认是否覆盖。'
    )
  }
  return t(
    'workbench.plugins_import_failed_guidance',
    '插件导入或安装失败，请稍后重试；若问题持续，请重新打开插件页。'
  )
}

export function PluginImportDialog({
  pluginApi,
  onCancel,
  onImported,
}: {
  pluginApi: LocalCodexPluginApi
  onCancel: () => void
  onImported: (result: LocalPluginImportCompletion) => void
}) {
  const { t } = useTranslation('common')
  const closeRef = useRef<HTMLButtonElement>(null)
  const [preview, setPreview] = useState<LocalPluginImportPreview | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [savingExample, setSavingExample] = useState(false)
  const [savedExamplePath, setSavedExamplePath] = useState('')
  const [riskConfirmed, setRiskConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = analyzing || importing || savingExample

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  async function choosePackage() {
    const selected = await invokeDesktopHost<{ canceled: boolean; filePaths: string[] }>(
      'dialog.open',
      {
        properties: ['openFile'],
        filters: [{ name: 'Wework plugin ZIP', extensions: ['zip'] }],
      }
    )
    const packagePath = selected.filePaths[0]
    if (selected.canceled || !packagePath) return
    setAnalyzing(true)
    setError(null)
    setRiskConfirmed(false)
    try {
      setPreview(await pluginApi.previewPluginImport(packagePath))
    } catch (previewError) {
      setPreview(null)
      setError(previewErrorGuidance(previewError, t))
    } finally {
      setAnalyzing(false)
    }
  }

  async function downloadExample() {
    const selected = await invokeDesktopHost<{ canceled: boolean; filePath: string | null }>(
      'dialog.save',
      {
        defaultPath: 'wework-plugin-example.zip',
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      }
    )
    if (selected.canceled || !selected.filePath) return
    setSavingExample(true)
    setError(null)
    setSavedExamplePath('')
    try {
      setSavedExamplePath(await pluginApi.savePluginExample(selected.filePath))
    } catch (saveError) {
      console.warn('[Wework] failed to save plugin example', saveError)
      setError(
        t('workbench.plugins_import_example_failed', '示例包保存失败，请更换保存位置后重试。')
      )
    } finally {
      setSavingExample(false)
    }
  }

  async function submit() {
    if (!preview?.valid || importing) return
    setImporting(true)
    setError(null)
    try {
      const imported = await pluginApi.importPluginPackage(preview, preview.existing)
      onImported(imported)
    } catch (importError) {
      console.warn('[Wework] plugin package import failed', importError)
      setError(importErrorGuidance(importError, t))
    } finally {
      setImporting(false)
    }
  }

  const needsRiskConfirmation = Boolean(preview?.executableCapabilities.length)
  const canSubmit = preview?.valid && (!needsRiskConfirmation || riskConfirmed) && !busy

  return (
    <div className="plugin-dialog-overlay fixed inset-0 z-modal flex items-center justify-center px-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-import-title"
        data-testid="plugin-import-dialog"
        className="plugin-dialog-surface flex max-h-[min(720px,92vh)] w-full max-w-[600px] flex-col overflow-hidden"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 px-5 pt-5">
          <div>
            <h2 id="plugin-import-title" className="heading-subsection">
              {t('workbench.plugins_import_title', '导入插件')}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {t(
                'workbench.plugins_import_description',
                '仅支持与 wework-plugins 一致的标准插件 ZIP。Skill 和 MCP 都需要放在插件内。'
              )}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            data-testid="plugin-import-close"
            aria-label={t('common.close', '关闭')}
            disabled={busy}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted hover:bg-surface disabled:opacity-40"
            onClick={onCancel}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              data-testid="plugin-import-select"
              disabled={busy}
              className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-medium text-background disabled:opacity-40"
              onClick={() => void choosePackage()}
            >
              {analyzing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {analyzing
                ? t('workbench.plugins_import_analyzing', '正在检查')
                : t('workbench.plugins_import_select', '选择插件 ZIP')}
            </button>
            <button
              type="button"
              data-testid="plugin-import-download-example"
              disabled={busy}
              className="flex h-10 items-center justify-center gap-2 rounded-lg border border-border/30 px-4 text-sm font-medium hover:bg-surface disabled:opacity-40"
              onClick={() => void downloadExample()}
            >
              {savingExample ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {t('workbench.plugins_import_download_example', '下载插件示例包')}
            </button>
          </div>

          {!preview && !error && (
            <div className="mt-4 rounded-xl bg-surface px-4 py-3 text-sm text-text-secondary">
              <p className="font-medium text-text-primary">ZIP</p>
              <p className="mt-1 font-mono text-xs">.codex-plugin/plugin.json</p>
              <p className="font-mono text-xs">skills/&lt;slug&gt;/SKILL.md</p>
              <p className="font-mono text-xs">.mcp.json</p>
            </div>
          )}

          {savedExamplePath && (
            <div
              data-testid="plugin-import-example-saved"
              className="mt-4 flex items-start gap-2 rounded-xl bg-green-500/8 px-3 py-3 text-sm text-green-700"
            >
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {t('workbench.plugins_import_example_saved', '示例包已保存：{{path}}', {
                  path: savedExamplePath,
                })}
              </span>
            </div>
          )}

          {preview && !preview.valid && (
            <div data-testid="plugin-import-issues" className="mt-4 space-y-2">
              {preview.issues.map((issue, index) => (
                <div key={`${issue.code}-${index}`} className="rounded-xl bg-red-500/8 px-3 py-3">
                  <div className="flex items-start gap-2 text-sm font-medium text-red-600">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{issueGuidance(issue, t)}</span>
                  </div>
                  {issue.path && (
                    <p className="mt-1 pl-6 font-mono text-xs text-text-muted">{issue.path}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {preview?.valid && (
            <div data-testid="plugin-import-preview" className="mt-4 space-y-3">
              <div className="rounded-xl bg-surface px-4 py-3">
                <div className="flex items-start gap-3">
                  <Archive className="mt-0.5 h-5 w-5 text-text-secondary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-base font-medium text-text-primary">
                        {preview.displayName}
                      </p>
                      <span className="text-xs text-text-muted">v{preview.version}</span>
                    </div>
                    <p className="mt-1 text-sm text-text-secondary">{preview.description}</p>
                    <p className="mt-2 text-xs text-text-muted">
                      {t(
                        'workbench.plugins_import_components',
                        '{{skills}} 个 Skill · {{mcps}} 个 MCP',
                        {
                          skills: preview.skillCount,
                          mcps: preview.mcpServerCount,
                        }
                      )}
                    </p>
                  </div>
                </div>
              </div>

              {preview.existing && (
                <div className="rounded-xl bg-orange-500/8 px-3 py-3 text-sm text-orange-700">
                  {t(
                    'workbench.plugins_import_existing',
                    '个人市场中已有 {{name}}（{{version}}）。继续后将覆盖并重新安装。',
                    { name: preview.name, version: preview.existingVersion ?? '-' }
                  )}
                </div>
              )}

              {needsRiskConfirmation && (
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/30 px-3 py-3 text-sm">
                  <input
                    type="checkbox"
                    data-testid="plugin-import-risk-confirm"
                    checked={riskConfirmed}
                    className="mt-0.5"
                    onChange={event => setRiskConfirmed(event.target.checked)}
                  />
                  <span>
                    <span className="font-medium text-text-primary">
                      {t('workbench.plugins_import_risk_title', '此插件包含可执行能力')}
                    </span>
                    <span className="mt-1 block text-text-secondary">
                      {preview.executableCapabilities.join(', ')}。
                      {t('workbench.plugins_import_risk_confirm', '我信任该插件的来源并允许安装。')}
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-xl bg-red-500/8 px-3 py-3 text-sm text-red-600"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-border/20 px-5 py-4">
          <button
            type="button"
            className="h-9 rounded-lg px-4 text-sm font-medium text-text-secondary hover:bg-surface"
            disabled={busy}
            onClick={onCancel}
          >
            {t('common.cancel', '取消')}
          </button>
          {preview?.valid && (
            <button
              type="button"
              data-testid="plugin-import-confirm"
              disabled={!canSubmit}
              className="flex h-9 items-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-medium text-background disabled:opacity-40"
              onClick={() => void submit()}
            >
              {importing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              {importing
                ? t('workbench.plugins_import_importing', '正在导入')
                : preview.existing
                  ? t('workbench.plugins_import_overwrite', '覆盖并重新安装')
                  : t('workbench.plugins_import_confirm', '导入并安装')}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}
