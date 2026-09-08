import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { LoaderCircle, PackagePlus, PlugZap, RefreshCw, RotateCw, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { DshSlotSurface } from '@/features/dsh-runtime/DshSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import {
  installCoreDshPlugin,
  readCoreDshPlugins,
  restartCoreDsh,
  setCoreDshPluginEnabled,
  type CoreDshPlugin,
  uninstallCoreDshPlugin,
  updateCoreDshPlugin,
} from '@/features/dsh-plugins/coreDshPlugins'
import { useTranslation } from '@/hooks/useTranslation'
import { MODE_MANAGED_GIT_PLUGIN } from '@/features/workbench-mode/workbenchMode'

type Operation =
  | 'install'
  | 'restart'
  | `toggle:${string}`
  | `uninstall:${string}`
  | `update:${string}`
  | null

export function CoreDshPluginManagementSection({
  onCreatePlugin,
}: {
  onCreatePlugin?: () => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [plugins, setPlugins] = useState<CoreDshPlugin[]>([])
  const [spec, setSpec] = useState('')
  const [loading, setLoading] = useState(true)
  const [operation, setOperation] = useState<Operation>(null)
  const [restartRequired, setRestartRequired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installConfirmation, setInstallConfirmation] = useState<string | null>(null)
  const [uninstallConfirmation, setUninstallConfirmation] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void readCoreDshPlugins()
      .then(nextPlugins => {
        if (current) setPlugins(nextPlugins)
      })
      .catch(reason => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [])

  const userPlugins = useMemo(() => plugins.filter(plugin => !plugin.immutable), [plugins])
  const builtIns = useMemo(() => plugins.filter(plugin => plugin.immutable), [plugins])

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
      <section data-testid="core-dsh-plugin-management">
        <header className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="heading-section text-text-primary">
              {t('workbench.core_dsh_plugins_title', 'Wework 插件')}
            </h2>
            <p className="mt-1 text-sm leading-5 text-text-secondary">
              {t(
                'workbench.core_dsh_plugins_description',
                '管理直接扩展 Wework 桌面能力的插件。修改会在重启 Wework 插件运行时后生效。'
              )}
            </p>
          </div>
          {onCreatePlugin ? (
            <DshSlotSurface
              className="shrink-0"
              entryId="wework-plugin-developer.create"
              props={{ onCreate: onCreatePlugin, t }}
              slot={WEWORK_DSH_SLOTS.pluginsAction}
              testId="core-dsh-plugin-page-actions"
            />
          ) : null}
        </header>

        <form
          className="mb-4 rounded-xl border border-border/40 bg-background p-4"
          data-testid="core-dsh-plugin-install-form"
          onSubmit={submit}
        >
          <label className="mb-2 block text-sm font-medium" htmlFor="core-dsh-plugin-spec">
            {t('workbench.core_dsh_plugins_install_label', '安装 Wework 插件')}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="core-dsh-plugin-spec"
              value={spec}
              onChange={event => setSpec(event.target.value)}
              placeholder={t(
                'workbench.core_dsh_plugins_install_placeholder',
                'package@version / github:owner/plugin / file:/absolute/path'
              )}
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
              {t('workbench.core_dsh_plugins_install', '安装')}
            </button>
          </div>
        </form>

        {restartRequired ? (
          <div
            className="mb-4 flex flex-col items-start justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 sm:flex-row sm:items-center"
            data-testid="core-dsh-plugin-restart-required"
          >
            <span className="text-sm">
              {t(
                'workbench.core_dsh_plugins_restart_required',
                '插件配置已更新。你可以继续管理插件，完成后统一重启 Wework 插件运行时。'
              )}
            </span>
            <button
              type="button"
              className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-warning/50 px-3 text-sm"
              data-testid="core-dsh-plugin-restart-button"
              disabled={operation !== null}
              onClick={() => void run('restart', restartCoreDsh)}
            >
              <RefreshCw className={`h-4 w-4 ${operation === 'restart' ? 'animate-spin' : ''}`} />
              {t('workbench.core_dsh_plugins_restart', '重启插件运行时')}
            </button>
          </div>
        ) : null}

        {error ? (
          <pre
            className="mb-4 max-h-44 overflow-auto whitespace-pre-wrap rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
            data-testid="core-dsh-plugin-management-error"
          >
            {error}
          </pre>
        ) : null}

        <div className="rounded-xl border border-border/40 bg-background">
          {loading ? (
            <div className="p-4 text-sm text-text-secondary">
              {t('workbench.core_dsh_plugins_loading', '正在读取 Wework 插件…')}
            </div>
          ) : null}
          {!loading && userPlugins.length === 0 ? (
            <div className="border-b border-border/25 p-4 text-sm text-text-secondary">
              {t('workbench.core_dsh_plugins_empty', '尚未安装用户 Wework 插件。')}
            </div>
          ) : null}
          {userPlugins.map(plugin => (
            <PluginRow
              key={plugin.name}
              plugin={plugin}
              operation={operation}
              onUpdate={() =>
                void run(`update:${plugin.name}`, async () => {
                  setPlugins(await updateCoreDshPlugin(plugin.name))
                  setRestartRequired(true)
                })
              }
              onToggle={() =>
                void run(`toggle:${plugin.name}`, async () => {
                  setPlugins(await setCoreDshPluginEnabled(plugin.name, !plugin.enabled))
                  setRestartRequired(true)
                })
              }
              onUninstall={() => setUninstallConfirmation(plugin.name)}
            />
          ))}
          <details>
            <summary className="cursor-pointer px-4 py-3 text-sm text-text-secondary">
              {t('workbench.core_dsh_plugins_builtins', '{{count}} 个 Wework 内置插件', {
                count: builtIns.length,
              })}
            </summary>
            {builtIns.map(plugin => (
              <PluginRow key={plugin.name} plugin={plugin} operation={operation} />
            ))}
          </details>
        </div>
      </section>

      <ConfirmDialog
        open={installConfirmation !== null}
        title={t('workbench.core_dsh_plugins_install_confirm_title', '安装 Wework 插件？')}
        description={t(
          'workbench.core_dsh_plugins_install_confirm_description',
          '插件及其安装脚本会以当前用户权限运行。仅安装你信任的 npm、Git 或本地包。'
        )}
        cancelLabel={t('common.cancel', '取消')}
        confirmLabel={t('workbench.core_dsh_plugins_install', '安装')}
        confirmTestId="core-dsh-plugin-install-confirm"
        onClose={() => setInstallConfirmation(null)}
        onConfirm={confirmInstall}
      />
      <ConfirmDialog
        open={uninstallConfirmation !== null}
        title={t('workbench.core_dsh_plugins_uninstall_confirm_title', '卸载 Wework 插件？')}
        description={t(
          'workbench.core_dsh_plugins_uninstall_confirm_description',
          '将从 Wework 插件运行时中移除 {{name}}。',
          { name: uninstallConfirmation ?? '' }
        )}
        cancelLabel={t('common.cancel', '取消')}
        confirmLabel={t('workbench.core_dsh_plugins_uninstall', '卸载')}
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
  onUpdate,
  onToggle,
  onUninstall,
}: {
  plugin: CoreDshPlugin
  operation: Operation
  onUpdate?: () => void
  onToggle?: () => void
  onUninstall?: () => void
}) {
  const { t } = useTranslation('common')
  const busy =
    operation === `toggle:${plugin.name}` ||
    operation === `update:${plugin.name}` ||
    operation === `uninstall:${plugin.name}`
  const source = plugin.repository || plugin.homepage || plugin.requestedSpec
  const modeManaged = plugin.name === MODE_MANAGED_GIT_PLUGIN

  return (
    <article
      className="flex min-h-[76px] items-center gap-3 border-b border-border/25 px-4 py-3"
      data-testid={`core-dsh-plugin-row-${plugin.name}`}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border/50 bg-muted/40">
        <PlugZap className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="truncate text-sm">{plugin.displayName}</strong>
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${
              plugin.enabled ? 'bg-success/10 text-success' : 'bg-muted text-text-secondary'
            }`}
          >
            {plugin.enabled
              ? t('workbench.core_dsh_plugins_enabled', '已启用')
              : t('workbench.core_dsh_plugins_disabled', '已停用')}
          </span>
        </div>
        <p className="mt-1 truncate text-xs text-text-muted">
          {plugin.name}
          {plugin.version ? ` · ${plugin.version}` : ''}
          {source ? ` · ${source}` : ''}
        </p>
        {modeManaged ? (
          <p className="mt-1 text-xs text-text-secondary">
            {t('workbench.core_dsh_plugins_managed_by_mode', '由“设置 → 通用 → 模式”管理')}
          </p>
        ) : null}
      </div>
      {!plugin.immutable && !modeManaged ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex h-11 w-11 items-center justify-center rounded-md border border-border disabled:opacity-50 md:h-8 md:w-8"
            aria-label={t('workbench.core_dsh_plugins_update_named', '更新 {{name}}', {
              name: plugin.displayName,
            })}
            data-testid={`core-dsh-plugin-update-${plugin.name}`}
            disabled={operation !== null || !plugin.canUpdate}
            onClick={onUpdate}
          >
            <RotateCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            className="min-h-11 min-w-11 rounded-md border border-border px-3 text-xs disabled:opacity-50 md:min-h-8 md:min-w-0"
            data-testid={`core-dsh-plugin-toggle-${plugin.name}`}
            disabled={operation !== null || !plugin.canToggle}
            onClick={onToggle}
          >
            {plugin.enabled
              ? t('workbench.core_dsh_plugins_disable', '停用')
              : t('workbench.core_dsh_plugins_enable', '启用')}
          </button>
          <button
            type="button"
            className="flex h-11 w-11 items-center justify-center rounded-md border border-border disabled:opacity-50 md:h-8 md:w-8"
            aria-label={t('workbench.core_dsh_plugins_uninstall_named', '卸载 {{name}}', {
              name: plugin.displayName,
            })}
            data-testid={`core-dsh-plugin-uninstall-${plugin.name}`}
            disabled={operation !== null || !plugin.canUninstall}
            onClick={onUninstall}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </article>
  )
}
