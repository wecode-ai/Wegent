import { FolderOpen, Loader2, Puzzle, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { getErrorMessage } from '@/lib/error-message'
import { openNativeDirectoryPicker } from '@/lib/native-directory-picker'

interface SmartAppPluginDialogProps {
  displayName: string
  onClose: () => void
  onInstall: (pluginSpec: string) => Promise<void>
}

export function SmartAppPluginDialog({
  displayName,
  onClose,
  onInstall,
}: SmartAppPluginDialogProps) {
  const { t } = useTranslation('common')
  const [pluginSpec, setPluginSpec] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function chooseDirectory() {
    const path = await openNativeDirectoryPicker()
    if (path) {
      setPluginSpec(path)
      setError(null)
    }
  }

  async function install() {
    const spec = pluginSpec.trim()
    if (!spec || busy) return
    setBusy(true)
    setError(null)
    try {
      await onInstall(spec)
      onClose()
    } catch (installError) {
      setError(
        getErrorMessage(
          installError,
          t('workbench.smart_app_plugin_install_failed', '添加 DSH 插件失败')
        )
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="plugin-dialog-overlay fixed inset-0 z-modal flex items-center justify-center px-6"
      data-testid="smart-app-plugin-dialog-backdrop"
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="smart-app-plugin-dialog-title"
        data-testid="smart-app-plugin-dialog"
        className="plugin-dialog-surface w-full max-w-[520px]"
        onClick={event => event.stopPropagation()}
      >
        <header className="plugin-dialog-divider flex items-start justify-between gap-4 border-b px-6 py-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface text-text-secondary">
              <Puzzle className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 id="smart-app-plugin-dialog-title" className="heading-subsection">
                {t('workbench.smart_app_plugin_title', '添加 DSH 插件')}
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                {t(
                  'workbench.smart_app_plugin_description',
                  '将插件加入 {{name}}；安装完成后会自动重新加载 DSH。'
                ).replace('{{name}}', displayName)}
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="smart-app-plugin-dialog-close"
            aria-label={t('common.close', '关闭')}
            disabled={busy}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-surface disabled:opacity-40"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="px-6 py-5">
          <label className="block">
            <span className="text-sm font-medium text-text-primary">
              {t('workbench.smart_app_plugin_source', '插件包或地址')}
            </span>
            <span className="mt-1 block text-xs leading-5 text-text-muted">
              {t(
                'workbench.smart_app_plugin_source_hint',
                '支持 npm 包名、Git URL、压缩包地址或本地插件目录。'
              )}
            </span>
            <input
              autoFocus
              data-testid="smart-app-plugin-spec-input"
              value={pluginSpec}
              placeholder={t(
                'workbench.smart_app_plugin_source_placeholder',
                '@scope/dsh-plugin、https://… 或本地目录'
              )}
              className="mt-2 h-10 w-full rounded-xl border border-border/50 bg-background px-3 text-sm text-text-primary outline-none transition-colors focus:border-focus focus:ring-2 focus:ring-focus/15"
              onChange={event => setPluginSpec(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') void install()
              }}
            />
          </label>

          <button
            type="button"
            data-testid="smart-app-plugin-choose-directory"
            disabled={busy}
            className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg px-2 text-sm font-medium text-text-secondary hover:bg-surface hover:text-text-primary disabled:opacity-40"
            onClick={() => void chooseDirectory()}
          >
            <FolderOpen className="h-4 w-4" />
            {t('workbench.smart_app_plugin_choose_directory', '选择插件目录')}
          </button>

          {error ? (
            <p
              role="alert"
              data-testid="smart-app-plugin-error"
              className="mt-3 rounded-lg bg-danger/10 p-3 text-sm text-danger"
            >
              {error}
            </p>
          ) : null}
        </div>

        <footer className="plugin-dialog-divider flex justify-end gap-2 border-t px-6 py-4">
          <Button
            size="sm"
            variant="ghost"
            data-testid="smart-app-plugin-cancel"
            disabled={busy}
            onClick={onClose}
          >
            {t('common.cancel', '取消')}
          </Button>
          <Button
            size="sm"
            data-testid="smart-app-plugin-confirm"
            disabled={!pluginSpec.trim() || busy}
            onClick={() => void install()}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {busy
              ? t('workbench.smart_app_plugin_installing', '正在添加')
              : t('workbench.smart_app_plugin_confirm', '添加并重新加载')}
          </Button>
        </footer>
      </section>
    </div>
  )
}
