import { Box, FolderOpen, RefreshCw, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import {
  chooseNodeExecutable,
  listExecutionEnvironments,
  type ExecutionEnvironmentStatus,
  useBuiltinNode,
} from '@/desktop/executionEnvironments'

import { SettingsPage, SettingsPageHeader } from './settings-ui'

function formatBytes(bytes: number) {
  if (bytes <= 0) return null
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

export function ExecutionEnvironmentsSettingsPage() {
  const { t } = useTranslation()
  const [environments, setEnvironments] = useState<ExecutionEnvironmentStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [actionId, setActionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setEnvironments(await listExecutionEnvironments())
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(), 0)
    return () => {
      window.clearTimeout(initialRefresh)
    }
  }, [refresh])

  useEffect(() => {
    if (!environments.some(item => item.state === 'downloading')) return
    const timer = window.setInterval(() => void refresh(), 1000)
    return () => window.clearInterval(timer)
  }, [environments, refresh])

  const runAction = async (id: string, action: () => Promise<unknown>) => {
    setActionId(id)
    setError(null)
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setActionId(null)
    }
  }

  return (
    <SettingsPage data-testid="execution-environments-settings-page">
      <SettingsPageHeader
        title={t('workbench.execution_environments_title', '执行环境')}
        description={t(
          'workbench.execution_environments_description',
          '管理智能体、Skills、MCP 和智能工作台运行脚本所需的环境。Wework 不会修改系统 PATH。'
        )}
      />

      {error && (
        <div
          data-testid="execution-environments-error"
          className="mb-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-600"
        >
          {error}
        </div>
      )}

      <div className="space-y-3">
        {loading && (
          <div className="rounded-2xl border border-border bg-surface/70 px-4 py-6 text-sm text-text-secondary">
            {t('workbench.execution_environments_loading', '正在检测执行环境…')}
          </div>
        )}
        {environments.map(environment => {
          const isNode = environment.id === 'node'
          const busy = actionId === environment.id
          const downloading = environment.state === 'downloading'
          const installed = environment.state === 'installed'
          const progress =
            environment.totalBytes > 0
              ? Math.min(100, (environment.downloadedBytes / environment.totalBytes) * 100)
              : 0
          const status = downloading
            ? t('workbench.execution_environment_downloading', '正在后台下载')
            : installed
              ? t('workbench.execution_environment_installed', '已安装')
              : environment.state === 'error'
                ? t('workbench.execution_environment_failed', '安装失败')
                : t('workbench.execution_environment_not_installed', '未安装')
          return (
            <section
              key={environment.id}
              data-testid={`execution-environment-${environment.id}`}
              className="rounded-2xl border border-border bg-surface/70 p-4"
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-text-secondary">
                  <Box className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-medium text-text-primary">
                      {isNode ? 'Node.js' : 'Python'}
                    </h2>
                    <span className="text-xs text-text-secondary">
                      {status}
                      {environment.source === 'electron'
                        ? ` · ${t(
                            'workbench.execution_environment_electron_builtin',
                            'Electron 内置'
                          )}`
                        : environment.source === 'configured'
                          ? ` · ${t('workbench.execution_environment_custom', '自定义')}`
                          : ''}
                      {environment.version ? ` · ${environment.version}` : ''}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-4 text-text-secondary">
                    {isNode
                      ? t(
                          'workbench.execution_environment_node_description',
                          '由 Wework 的 Electron 运行时直接提供，供 Codex、Claude Code、JavaScript Skills、MCP 和智能工作台使用，不会额外下载 Node。'
                        )
                      : t(
                          'workbench.execution_environment_python_description',
                          '默认不下载。请在系统中手动安装 Python，Wework 会自动检测。'
                        )}
                  </p>
                  {downloading && (
                    <div className="mt-3">
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-text-primary transition-[width]"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <div className="mt-1 text-xs text-text-secondary">
                        {formatBytes(environment.downloadedBytes) ?? '0 B'} /{' '}
                        {formatBytes(environment.totalBytes) ?? '—'}
                      </div>
                    </div>
                  )}
                  {environment.error && (
                    <p className="mt-2 text-xs text-red-600">{environment.error}</p>
                  )}
                  {installed && environment.path && (
                    <p className="mt-2 truncate text-xs text-text-muted" title={environment.path}>
                      {environment.path}
                    </p>
                  )}
                  {environment.restartRequired && (
                    <div
                      data-testid="execution-environment-node-restart-required"
                      className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-4 text-amber-700"
                    >
                      {environment.configuredPath
                        ? t(
                            'workbench.execution_environment_custom_restart_required',
                            '已选择 {{path}}，重启 Wework 后生效。',
                            { path: environment.configuredPath }
                          )
                        : t(
                            'workbench.execution_environment_builtin_restart_required',
                            '已恢复 Electron 内置 Node，重启 Wework 后生效。'
                          )}
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {isNode && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        data-testid="execution-environment-node-choose"
                        onClick={() =>
                          void runAction('node', async () => {
                            await chooseNodeExecutable()
                          })
                        }
                      >
                        <FolderOpen />
                        {t('workbench.execution_environment_choose_custom_node', '选择自定义 Node')}
                      </Button>
                    )}
                    {isNode &&
                      (environment.source === 'configured' ||
                        Boolean(environment.configuredPath)) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          data-testid="execution-environment-node-use-builtin"
                          onClick={() => void runAction('node', useBuiltinNode)}
                        >
                          <RotateCcw />
                          {t('workbench.execution_environment_use_builtin_node', '使用内置 Node')}
                        </Button>
                      )}
                    {!isNode && (
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid="execution-environment-python-refresh"
                        onClick={() => void refresh()}
                      >
                        <RefreshCw />
                        {t('workbench.execution_environment_refresh', '重新检测')}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </section>
          )
        })}
      </div>
    </SettingsPage>
  )
}
