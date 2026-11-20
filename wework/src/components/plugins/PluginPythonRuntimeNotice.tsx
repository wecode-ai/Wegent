import { Download, X } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { executionEnvironmentResource } from '@/desktop/executionEnvironmentResource'
import { useTranslation } from '@/hooks/useTranslation'

export function PluginPythonRuntimeNotice() {
  const { t } = useTranslation('common')
  const snapshot = useSyncExternalStore(
    executionEnvironmentResource.subscribe,
    executionEnvironmentResource.getSnapshot
  )
  const status = snapshot.environments.find(environment => environment.id === 'python')
  const [dismissedRevision, setDismissedRevision] = useState<number | null>(null)
  const retrying = snapshot.preparingPython
  if (
    dismissedRevision === snapshot.noticeRevision ||
    !status ||
    !['downloading', 'error'].includes(status.state)
  )
    return null
  const failed = status.state === 'error'
  const determinate = status.phase === 'download' && status.totalBytes > 0
  const progress = determinate
    ? Math.max(0, Math.min(100, Math.floor((status.downloadedBytes / status.totalBytes) * 100)))
    : 0
  const label = failed
    ? t('workbench.plugin_python_failed', '插件 Python 环境准备失败')
    : status.phase === 'install'
      ? t('workbench.plugin_python_installing', '正在安装插件 Python 环境…')
      : status.phase === 'verify'
        ? t('workbench.plugin_python_verifying', '正在验证插件 Python 环境…')
        : t('workbench.plugin_python_downloading', '正在下载插件 Python 环境…')
  // AppShell is fixed and owns a stacking context; stay beside its modal descendants.
  return (
    <aside
      data-testid="plugin-python-runtime-notice"
      data-embedded-browser-occlusion
      aria-label={label}
      className="fixed bottom-4 right-4 z-popover w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-background p-4 text-text-primary shadow-lg"
    >
      <div className="flex items-start gap-2">
        <Download className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <p role={failed ? 'alert' : 'status'} className="min-w-0 flex-1 text-sm font-medium">
          {label}
        </p>
        <button
          type="button"
          data-testid="plugin-python-runtime-dismiss"
          aria-label={t('workbench.plugin_python_dismiss', '关闭提示')}
          onClick={() => setDismissedRevision(snapshot.noticeRevision)}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted md:h-7 md:w-7"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-2 text-sm text-text-secondary">
        {status.temporaryPythonVersion && !failed
          ? t('workbench.plugin_python_temporary', {
              defaultValue: '插件临时使用本机 Python {{version}}，托管环境继续准备。',
              version: status.temporaryPythonVersion,
            })
          : failed
            ? t(
                'workbench.plugin_python_retry_hint',
                '请检查网络并重试安装，安装完成后重新执行插件操作。'
              )
            : t(
                'workbench.plugin_python_preparing_hint',
                '插件运行环境正在后台准备，其他任务可以继续。'
              )}
      </p>
      {failed ? (
        <Button
          className="mt-3 min-h-11 md:min-h-0"
          variant="outline"
          size="sm"
          disabled={retrying}
          data-testid="plugin-python-runtime-retry"
          onClick={() => void executionEnvironmentResource.preparePython().catch(() => undefined)}
        >
          {t('workbench.execution_environment_retry', '重试安装')}
        </Button>
      ) : (
        <div className="mt-3">
          <div
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={determinate ? progress : undefined}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={
                determinate
                  ? 'h-full bg-text-primary transition-[width] motion-reduce:transition-none'
                  : 'h-full w-1/3 animate-pulse bg-text-primary motion-reduce:animate-none'
              }
              style={determinate ? { width: `${progress}%` } : undefined}
            />
          </div>
          {determinate && <p className="mt-1 text-xs text-text-secondary">{progress}%</p>}
        </div>
      )}
    </aside>
  )
}
