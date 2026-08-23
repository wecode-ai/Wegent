import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { LoaderCircle, PackagePlus, PlugZap, RefreshCw, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  installCoreDshPlugin,
  readCoreDshPlugins,
  restartCoreDsh,
  setCoreDshPluginActive,
  type CoreDshPlugin,
  uninstallCoreDshPlugin,
} from '@/features/dsh-plugins/coreDshPlugins'
import { isElectronRuntime } from '@/lib/runtime-environment'

type Operation = 'install' | 'restart' | `toggle:${string}` | `uninstall:${string}` | null

export function CoreDshPluginManagementSection() {
  const [plugins, setPlugins] = useState<CoreDshPlugin[]>([])
  const [spec, setSpec] = useState('')
  const [loading, setLoading] = useState(isElectronRuntime)
  const [operation, setOperation] = useState<Operation>(null)
  const [restartRequired, setRestartRequired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installConfirmation, setInstallConfirmation] = useState<string | null>(null)
  const [uninstallConfirmation, setUninstallConfirmation] = useState<string | null>(null)

  useEffect(() => {
    if (!isElectronRuntime()) return
    const controller = new AbortController()
    void readCoreDshPlugins(controller.signal)
      .then(nextPlugins => {
        if (!controller.signal.aborted) setPlugins(nextPlugins)
      })
      .catch(reason => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [])

  const userPlugins = useMemo(() => plugins.filter(plugin => !plugin.immutable), [plugins])
  const builtIns = useMemo(() => plugins.filter(plugin => plugin.immutable), [plugins])
  if (!isElectronRuntime()) return null

  const run = async (next: Exclude<Operation, null>, action: () => Promise<void>) => {
    setOperation(next)
    setError(null)
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setOperation(null)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const requested = spec.trim()
    if (!requested || operation) return
    setInstallConfirmation(requested)
  }

  const confirmInstall = () => {
    const requested = installConfirmation
    if (!requested || operation) return
    setInstallConfirmation(null)
    void run('install', async () => {
      setPlugins(await installCoreDshPlugin(requested))
      setSpec('')
      setRestartRequired(true)
    })
  }

  return (
    <>
      <section className="mb-7" data-testid="core-dsh-plugin-management">
        <header className="mb-3">
          <h2 className="heading-section text-text-primary">Core DSH 扩展</h2>
          <p className="mt-1 text-sm leading-5 text-text-secondary">
            主协议是 Wework 发布的 ctx.wework 扩展宿主，插件通过 ctx.wework.extensions.register
            注册扩展点；当前已发布 wework.workspace.sidebar.tab，betterSidebar 仅作为兼容适配层。
          </p>
        </header>
        <form
          className="mb-3 rounded-xl border border-border/40 bg-background p-4"
          data-testid="core-dsh-plugin-install-form"
          onSubmit={submit}
        >
          <label className="mb-2 block text-sm font-medium" htmlFor="core-dsh-plugin-spec">
            手工安装 DSH 插件
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="core-dsh-plugin-spec"
              value={spec}
              onChange={event => setSpec(event.target.value)}
              placeholder="github:owner/plugin / package@version / file:/absolute/path"
              className="min-h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              data-testid="core-dsh-plugin-spec-input"
              disabled={operation !== null}
            />
            <button
              type="submit"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
              data-testid="core-dsh-plugin-install-button"
              disabled={!spec.trim() || operation !== null}
            >
              {operation === 'install' ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <PackagePlus className="h-4 w-4" />
              )}
              安装
            </button>
          </div>
        </form>
        {restartRequired ? (
          <div
            className="mb-3 flex items-center justify-between rounded-xl border border-warning/40 bg-warning/10 px-4 py-3"
            data-testid="core-dsh-plugin-restart-required"
          >
            <span className="text-sm">插件配置已更新，需要重启核心运行时。</span>
            <button
              type="button"
              className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-warning/50 px-3 text-sm"
              data-testid="core-dsh-plugin-restart-button"
              disabled={operation !== null}
              onClick={() => void run('restart', restartCoreDsh)}
            >
              <RefreshCw className={`h-4 w-4 ${operation === 'restart' ? 'animate-spin' : ''}`} />
              立即重启
            </button>
          </div>
        ) : null}
        {error ? (
          <pre
            className="mb-3 max-h-44 overflow-auto whitespace-pre-wrap rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
            data-testid="core-dsh-plugin-management-error"
          >
            {error}
          </pre>
        ) : null}
        <div className="rounded-xl border border-border/40 bg-background">
          {loading ? (
            <div className="p-4 text-sm text-text-secondary">正在读取 Core DSH 插件…</div>
          ) : null}
          {!loading && userPlugins.length === 0 ? (
            <div className="border-b border-border/25 p-4 text-sm text-text-secondary">
              尚未手工安装插件。
            </div>
          ) : null}
          {userPlugins.map(plugin => (
            <PluginRow
              key={plugin.name}
              plugin={plugin}
              operation={operation}
              onToggle={() =>
                void run(`toggle:${plugin.name}`, async () => {
                  setPlugins(await setCoreDshPluginActive(plugin.name, !plugin.active))
                  setRestartRequired(true)
                })
              }
              onUninstall={() => setUninstallConfirmation(plugin.name)}
            />
          ))}
          <details>
            <summary className="cursor-pointer px-4 py-3 text-sm text-text-secondary">
              {builtIns.length} 个内置运行时插件
            </summary>
            {builtIns.map(plugin => (
              <PluginRow key={plugin.name} plugin={plugin} operation={operation} />
            ))}
          </details>
        </div>
      </section>
      <ConfirmDialog
        open={installConfirmation !== null}
        title="安装 Core DSH 插件？"
        description="插件会以当前用户权限运行。仅安装可信的 npm、Git 或本地包。"
        cancelLabel="取消"
        confirmLabel="安装"
        confirmTestId="core-dsh-plugin-install-confirm"
        onClose={() => setInstallConfirmation(null)}
        onConfirm={confirmInstall}
      />
      <ConfirmDialog
        open={uninstallConfirmation !== null}
        title="卸载 Core DSH 插件？"
        description={`将从 Core DSH profile 中移除 ${uninstallConfirmation ?? ''}。`}
        cancelLabel="取消"
        confirmLabel="卸载"
        confirmTestId="core-dsh-plugin-uninstall-confirm"
        destructive
        onClose={() => setUninstallConfirmation(null)}
        onConfirm={() => {
          const name = uninstallConfirmation
          if (!name || operation) return
          setUninstallConfirmation(null)
          void run(`uninstall:${name}`, async () => {
            setPlugins(await uninstallCoreDshPlugin(name))
            setRestartRequired(true)
          })
        }}
      />
    </>
  )
}

function PluginRow({
  plugin,
  operation,
  onToggle,
  onUninstall,
}: {
  plugin: CoreDshPlugin
  operation: Operation
  onToggle?: () => void
  onUninstall?: () => void
}) {
  const busy = operation === `toggle:${plugin.name}` || operation === `uninstall:${plugin.name}`
  return (
    <article
      className="flex min-h-[76px] items-center gap-3 border-b border-border/25 px-4 py-3"
      data-testid={`core-dsh-plugin-row-${plugin.name}`}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border/50 bg-muted/40">
        <PlugZap className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <strong className="truncate text-sm">{plugin.displayName}</strong>
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${plugin.active ? 'bg-success/10 text-success' : 'bg-muted text-text-secondary'}`}
          >
            {plugin.active ? '已激活' : '未激活'}
          </span>
          {!plugin.bundle ? (
            <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs text-warning">
              普通依赖
            </span>
          ) : null}
        </div>
        <p className="mt-1 truncate text-xs text-text-muted">
          {plugin.name} · {plugin.version || plugin.spec}
        </p>
      </div>
      {!plugin.immutable ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="min-h-8 rounded-md border border-border px-3 text-xs disabled:opacity-50"
            data-testid={`core-dsh-plugin-toggle-${plugin.name}`}
            disabled={operation !== null || !plugin.bundle}
            onClick={onToggle}
          >
            {busy ? '…' : plugin.active ? '停用' : '激活'}
          </button>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border"
            aria-label="卸载插件"
            data-testid={`core-dsh-plugin-uninstall-${plugin.name}`}
            disabled={operation !== null}
            onClick={onUninstall}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </article>
  )
}
