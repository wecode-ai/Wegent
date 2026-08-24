import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronDown,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react'
import type { HarnessAppPreview } from '@/api/local/harnessApps'
import { Button } from '@/components/ui/button'
import type { LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import { useTranslation } from '@/hooks/useTranslation'

interface HarnessAppInstallDialogProps {
  busy: boolean
  error: string | null
  modelKey: string
  modelOptions: LocalHarnessModelOption[]
  preview: HarnessAppPreview
  onCancel: () => void
  onChooseAnother: () => void
  onInstall: () => void
  onModelChange: (modelKey: string) => void
}

export function HarnessAppInstallDialog({
  busy,
  error,
  modelKey,
  modelOptions,
  preview,
  onCancel,
  onChooseAnother,
  onInstall,
  onModelChange,
}: HarnessAppInstallDialogProps) {
  const { t } = useTranslation('common')
  const packageName = preview.archivePath.split(/[\\/]/).pop() ?? preview.archivePath
  const manifest = preview.manifest
  const canInstall = preview.valid && Boolean(manifest) && Boolean(modelKey) && !busy

  return (
    <div
      data-testid="harness-app-install-backdrop"
      className="plugin-dialog-overlay fixed inset-0 z-modal flex items-center justify-center px-6"
      onClick={() => {
        if (!busy) onCancel()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="harness-app-install-title"
        data-testid="harness-app-preview"
        className="plugin-dialog-surface flex max-h-[min(720px,92vh)] w-full max-w-[560px] flex-col overflow-hidden"
        onClick={event => event.stopPropagation()}
      >
        <header className="plugin-dialog-divider flex items-start justify-between gap-4 border-b px-6 py-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface text-text-secondary">
              <Archive className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 id="harness-app-install-title" className="heading-subsection">
                {t('workbench.harness_apps_install_title', '安装智能工作台')}
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                {t(
                  'workbench.harness_apps_install_description',
                  '检查智能工作台信息，并选择它运行时使用的 Wework 模型。'
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="harness-app-install-close"
            aria-label={t('common.close', '关闭')}
            disabled={busy}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-surface disabled:opacity-40 sm:h-9 sm:w-9"
            onClick={onCancel}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {preview.valid && manifest ? (
            <div className="space-y-5">
              <div className="rounded-xl border border-border/30 bg-surface/60 p-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border/30 bg-background">
                    <Archive className="h-5 w-5 text-text-secondary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h3 className="font-medium text-text-primary">{manifest.displayName}</h3>
                      <span className="rounded-md bg-background px-1.5 py-0.5 text-xs text-text-muted">
                        v{manifest.version}
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-5 text-text-secondary">
                      {manifest.description}
                    </p>
                    <p className="mt-2 truncate text-xs text-text-muted" title={packageName}>
                      {packageName}
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-medium text-text-primary">
                  {t('workbench.harness_apps_compatibility', '运行环境')}
                </h3>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div className="flex items-center gap-2 rounded-xl border border-border/30 px-3 py-2.5">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
                    <div className="min-w-0">
                      <p className="text-xs text-text-muted">DeepSeek Harness</p>
                      <p className="truncate text-sm font-medium text-text-primary">
                        {manifest.requirements.dsh}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 rounded-xl border border-border/30 px-3 py-2.5">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
                    <div className="min-w-0">
                      <p className="text-xs text-text-muted">Node.js</p>
                      <p className="truncate text-sm font-medium text-text-primary">
                        {manifest.requirements.node}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <label className="block">
                <span className="text-sm font-medium text-text-primary">
                  {t('workbench.harness_apps_model', '绑定 Wework 模型')}
                </span>
                <span className="mt-1 block text-xs leading-5 text-text-muted">
                  {t(
                    'workbench.harness_apps_model_hint',
                    '智能工作台启动后通过 Wework 的模型连接发起请求，不同智能工作台可以分别绑定。'
                  )}
                </span>
                <span className="relative mt-2 block">
                  <select
                    data-testid="harness-app-model-select"
                    className="h-10 w-full appearance-none rounded-xl border border-border/50 bg-background px-3 pr-10 text-sm text-text-primary outline-none transition-colors focus:border-focus focus:ring-2 focus:ring-focus/15"
                    value={modelKey}
                    onChange={event => onModelChange(event.target.value)}
                  >
                    <option value="">{t('workbench.harness_apps_model_choose')}</option>
                    {modelOptions.map(option => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-text-muted" />
                </span>
              </label>

              {modelOptions.length === 0 ? (
                <div className="flex items-start gap-2 rounded-xl bg-orange-500/8 px-3 py-3 text-sm text-orange-700">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {t(
                      'workbench.harness_apps_no_models',
                      '当前没有可用的 Wework 模型，请先在模型设置中完成配置。'
                    )}
                  </span>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-xl bg-red-500/8 px-4 py-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
                <div>
                  <h3 className="text-sm font-medium text-red-600">
                    {t('workbench.harness_apps_invalid_title', '无法安装这个智能工作台')}
                  </h3>
                  <p className="mt-1 text-sm leading-5 text-text-secondary">
                    {preview.issues.join('；')}
                  </p>
                </div>
              </div>
            </div>
          )}

          {error ? (
            <div
              data-testid="harness-app-error"
              className="mt-4 flex items-start gap-2 rounded-xl bg-red-500/8 px-3 py-3 text-sm text-red-600"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
        </div>

        <footer className="plugin-dialog-divider flex shrink-0 items-center justify-between gap-3 border-t px-6 py-4">
          <button
            type="button"
            data-testid="harness-app-choose-another"
            disabled={busy}
            className="flex h-11 items-center gap-2 rounded-lg px-2 text-sm font-medium text-text-secondary hover:bg-surface disabled:opacity-40 sm:h-9"
            onClick={onChooseAnother}
          >
            <RefreshCw className="h-4 w-4" />
            {t('workbench.harness_apps_choose_another', '重新选择')}
          </button>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              data-testid="harness-app-install-cancel"
              disabled={busy}
              className="h-11 sm:h-9"
              onClick={onCancel}
            >
              {t('common.cancel', '取消')}
            </Button>
            {preview.valid && manifest ? (
              <Button
                size="sm"
                data-testid="harness-app-install-confirm"
                disabled={!canInstall}
                onClick={onInstall}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {busy
                  ? t('workbench.harness_apps_installing', '正在安装')
                  : t('workbench.harness_apps_install', '安装')}
              </Button>
            ) : null}
          </div>
        </footer>
      </section>
    </div>
  )
}
