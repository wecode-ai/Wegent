import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  type CoreDshPlugin,
  installCoreDshPlugin,
  readCoreDshPlugins,
  restartCoreDsh,
  setCoreDshPluginEnabled,
  uninstallCoreDshPlugin,
  updateCoreDshPlugin,
} from '@/features/dsh-plugins/coreDshPlugins'
import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import {
  MODE_MANAGED_GIT_PLUGIN,
  MODE_MANAGED_HOME_PLUGINS,
} from '@/features/workbench-mode/workbenchMode'
import { useTranslation } from '@/hooks/useTranslation'
import { createAsyncResource, getIdleResourceSnapshot } from '@wegent/chat-core/async-resource'
import {
  CollapsiblePanel,
  CollapsibleRoot,
  CollapsibleTrigger,
} from '@wegent/collaboration/controls/Collapsible'
import { DeleteIconButton } from '@wegent/collaboration/controls/DeleteIconButton'
import { DialogForm } from '@wegent/collaboration/controls/DialogForm'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Field, FieldLabel } from '@wegent/collaboration/controls/Field'
import { IconButton } from '@wegent/collaboration/controls/IconButton'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { LoaderCircle, PackagePlus, PlugZap, RefreshCw, X } from 'lucide-react'
import { type FormEvent, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { MarketplaceSearchInput } from './MarketplaceSearchInput'

const EMPTY_PLUGINS: CoreDshPlugin[] = []
const ERROR_AUTO_DISMISS_MS = 8_000

function matchesPluginQuery(plugin: CoreDshPlugin, normalizedQuery: string): boolean {
  return [
    plugin.displayName,
    plugin.name,
    plugin.description,
    plugin.requestedSpec,
    plugin.repository,
    plugin.homepage,
  ].some(field => field.toLowerCase().includes(normalizedQuery))
}

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
  const resource = useMemo(
    () => createAsyncResource('core-dsh-plugins', () => readCoreDshPlugins()),
    []
  )
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const plugins = snapshot.data ?? EMPTY_PLUGINS
  const setPlugins = (next: CoreDshPlugin[]) => resource.update(() => next)
  const [spec, setSpec] = useState('')
  const loading = snapshot.status === 'idle' || snapshot.status === 'loading'
  const [operation, setOperation] = useState<Operation>(null)
  const [restartRequired, setRestartRequired] = useState(false)
  const [operationError, setError] = useState<string | null>(null)
  const [dismissedSnapshotError, setDismissedSnapshotError] = useState<unknown>(null)
  const errorTimeoutRef = useRef<number | null>(null)
  const snapshotError =
    snapshot.status === 'error' && snapshot.error !== dismissedSnapshotError
      ? String(snapshot.error instanceof Error ? snapshot.error.message : snapshot.error)
      : null
  const error = operationError ?? snapshotError
  const [uninstallConfirmation, setUninstallConfirmation] = useState<string | null>(null)
  const [installDialogOpen, setInstallDialogOpen] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const userPlugins = useMemo(() => plugins.filter(plugin => !plugin.immutable), [plugins])
  const builtIns = useMemo(() => plugins.filter(plugin => plugin.immutable), [plugins])
  const normalizedQuery = searchQuery.trim().toLowerCase()
  const filteredUserPlugins = useMemo(
    () =>
      normalizedQuery
        ? userPlugins.filter(plugin => matchesPluginQuery(plugin, normalizedQuery))
        : userPlugins,
    [userPlugins, normalizedQuery]
  )
  const filteredBuiltIns = useMemo(
    () =>
      normalizedQuery
        ? builtIns.filter(plugin => matchesPluginQuery(plugin, normalizedQuery))
        : builtIns,
    [builtIns, normalizedQuery]
  )
  const showBuiltIns = !normalizedQuery || filteredBuiltIns.length > 0

  const closeInstallDialog = () => {
    if (operation === 'install') return
    setInstallDialogOpen(false)
    setInstallError(null)
  }

  const clearErrorTimer = useCallback(() => {
    if (errorTimeoutRef.current === null) return
    window.clearTimeout(errorTimeoutRef.current)
    errorTimeoutRef.current = null
  }, [])

  const attachSection = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return
      return () => clearErrorTimer()
    },
    [clearErrorTimer]
  )

  const showOperationError = (message: string) => {
    clearErrorTimer()
    setError(message)
    errorTimeoutRef.current = window.setTimeout(() => {
      errorTimeoutRef.current = null
      setError(null)
    }, ERROR_AUTO_DISMISS_MS)
  }

  const dismissError = () => {
    clearErrorTimer()
    setError(null)
    if (snapshot.status === 'error') {
      setDismissedSnapshotError(snapshot.error)
    }
  }

  const run = async (next: Exclude<Operation, null>, action: () => Promise<void>) => {
    setOperation(next)
    clearErrorTimer()
    setError(null)
    resource.update(value => value)
    try {
      await action()
    } catch (reason) {
      showOperationError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setOperation(null)
    }
  }

  const handleCreatePlugin = async () => {
    if (!onCreatePlugin) return
    clearErrorTimer()
    setError(null)
    try {
      await onCreatePlugin()
    } catch (reason) {
      showOperationError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const requested = spec.trim()
    if (!requested || operation) return
    void (async () => {
      setOperation('install')
      setInstallError(null)
      resource.update(value => value)
      try {
        setPlugins(await installCoreDshPlugin(requested))
        setSpec('')
        setRestartRequired(true)
        setInstallDialogOpen(false)
      } catch (reason) {
        setInstallError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setOperation(null)
      }
    })()
  }

  return (
    <>
      <section ref={attachSection} data-testid="core-dsh-plugin-management">
        <header className="mb-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-4">
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
          <div className="flex w-full shrink-0 flex-wrap items-center gap-2 md:w-auto md:flex-nowrap">
            <div className="flex min-w-0 flex-1 md:w-56 md:flex-none">
              <MarketplaceSearchInput
                initialValue=""
                label={t('workbench.plugins_search_plugins', '搜索插件')}
                placeholder={t('workbench.plugins_marketplace_search', '搜索插件')}
                clearLabel={t('workbench.plugins_clear_search', '清空搜索')}
                inputTestId="core-dsh-plugin-search-input"
                clearTestId="core-dsh-plugin-search-clear"
                debounceMs={0}
                onQueryChange={setSearchQuery}
              />
            </div>
            <ControlButton
              variant="outline"
              type="button"
              data-testid="core-dsh-plugin-open-install-button"
              disabled={operation !== null}
              onClick={() => {
                setInstallError(null)
                setInstallDialogOpen(true)
              }}
            >
              <PackagePlus aria-hidden="true" />
              {t('workbench.core_dsh_plugins_install_open', '安装插件')}
            </ControlButton>
            {onCreatePlugin ? (
              <div className="shrink-0" data-testid="core-dsh-plugin-page-actions">
                <DshContributionSlotSurface
                  entryId="wework-plugin-developer.create"
                  props={{ onCreate: handleCreatePlugin, t }}
                  slot={WEWORK_DSH_SLOTS.pluginsAction}
                />
              </div>
            ) : null}
          </div>
        </header>

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
            <ControlButton
              variant="outline"
              type="button"
              data-testid="core-dsh-plugin-restart-button"
              disabled={operation !== null}
              onClick={() => void run('restart', restartCoreDsh)}
            >
              <RefreshCw
                aria-hidden="true"
                className={operation === 'restart' ? 'animate-spin' : undefined}
              />
              {t('workbench.core_dsh_plugins_restart', '重启插件运行时')}
            </ControlButton>
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-destructive"
            data-testid="core-dsh-plugin-management-error"
          >
            <pre className="max-h-44 min-w-0 flex-1 overflow-auto whitespace-pre-wrap py-1 text-xs leading-5">
              {error}
            </pre>
            <IconButton
              type="button"
              tone="danger"
              density="compact"
              aria-label={t('workbench.plugins_dismiss_notice', '关闭提示')}
              data-testid="core-dsh-plugin-management-error-dismiss"
              onClick={dismissError}
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </IconButton>
          </div>
        ) : null}

        <div className="rounded-xl border border-border/40 bg-background">
          {loading ? (
            <div className="p-4 text-sm text-text-secondary">
              {t('workbench.core_dsh_plugins_loading', '正在读取 Wework 插件…')}
            </div>
          ) : null}
          {!loading && !normalizedQuery && userPlugins.length === 0 ? (
            <div className="border-b border-border/25 p-4 text-sm text-text-secondary">
              {t('workbench.core_dsh_plugins_empty', '尚未安装用户 Wework 插件。')}
            </div>
          ) : null}
          {!loading &&
          normalizedQuery &&
          filteredUserPlugins.length === 0 &&
          filteredBuiltIns.length === 0 ? (
            <div
              className="p-4 text-sm text-text-secondary"
              data-testid="core-dsh-plugin-search-empty"
            >
              {t('workbench.core_dsh_plugins_search_empty', '没有匹配的 Wework 插件。')}
            </div>
          ) : null}
          {filteredUserPlugins.map(plugin => (
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
          {showBuiltIns ? (
            <CollapsibleRoot>
              <CollapsibleTrigger
                className="cursor-pointer px-4 py-3 text-sm text-text-secondary"
                data-testid="core-dsh-plugin-management-section-toggle"
              >
                {t('workbench.core_dsh_plugins_builtins', '{{count}} 个 Wework 内置插件', {
                  count: filteredBuiltIns.length,
                })}
              </CollapsibleTrigger>
              <CollapsiblePanel>
                {filteredBuiltIns.map(plugin => (
                  <PluginRow key={plugin.name} plugin={plugin} operation={operation} />
                ))}
              </CollapsiblePanel>
            </CollapsibleRoot>
          ) : null}
        </div>
      </section>

      {installDialogOpen ? (
        <CoreDshPluginInstallDialog
          spec={spec}
          installing={operation === 'install'}
          error={installError}
          onSpecChange={next => {
            setSpec(next)
            setInstallError(null)
          }}
          onClose={closeInstallDialog}
          onSubmit={submit}
        />
      ) : null}

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

function CoreDshPluginInstallDialog({
  spec,
  installing,
  error,
  onSpecChange,
  onClose,
  onSubmit,
}: {
  spec: string
  installing: boolean
  error: string | null
  onSpecChange: (value: string) => void
  onClose: () => void
  onSubmit: (event: FormEvent) => void
}) {
  const { t } = useTranslation('common')
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div
      className="plugin-dialog-overlay fixed inset-0 z-modal flex items-center justify-center px-6"
      onClick={installing ? undefined : onClose}
    >
      <DialogSurface
        onClose={installing ? undefined : onClose}
        initialFocus={() => inputRef.current}
        render={
          <DialogForm
            aria-labelledby="core-dsh-plugin-install-title"
            data-testid="core-dsh-plugin-install-form"
            className="plugin-dialog-surface w-full max-w-[480px] p-6 text-text-primary"
            onClick={event => event.stopPropagation()}
            onSubmit={onSubmit}
          />
        }
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id="core-dsh-plugin-install-title" className="heading-subsection text-text-primary">
            {t('workbench.core_dsh_plugins_install_label', '安装 Wework 插件')}
          </h2>
          <IconButton
            type="button"
            density="compact"
            aria-label={t('common.cancel', '取消')}
            data-testid="core-dsh-plugin-install-close"
            disabled={installing}
            onClick={onClose}
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="mt-4">
          <Field>
            <FieldLabel htmlFor="core-dsh-plugin-spec">
              {t('workbench.core_dsh_plugins_source', '来源')}
            </FieldLabel>
            <ControlInput
              ref={inputRef}
              id="core-dsh-plugin-spec"
              value={spec}
              onChange={event => onSpecChange(event.target.value)}
              placeholder={t(
                'workbench.core_dsh_plugins_install_placeholder',
                'package@version / github:owner/plugin / file:/absolute/path'
              )}
              className="w-full"
              data-testid="core-dsh-plugin-spec-input"
              disabled={installing}
            />
          </Field>
        </div>
        {error ? (
          <pre
            className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
            data-testid="core-dsh-plugin-install-error"
          >
            {error}
          </pre>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <ControlButton
            variant="outline"
            type="button"
            data-testid="core-dsh-plugin-install-cancel"
            disabled={installing}
            onClick={onClose}
          >
            {t('common.cancel', '取消')}
          </ControlButton>
          <ControlButton
            variant="primary"
            type="submit"
            data-testid="core-dsh-plugin-install-button"
            disabled={!spec.trim() || installing}
          >
            {installing ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" />
            ) : (
              <PackagePlus aria-hidden="true" />
            )}
            {t('workbench.core_dsh_plugins_install', '安装')}
          </ControlButton>
        </div>
      </DialogSurface>
    </div>
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
  const updating = operation === `update:${plugin.name}`
  const source = plugin.repository || plugin.homepage || plugin.requestedSpec
  const modeManaged =
    plugin.name === MODE_MANAGED_GIT_PLUGIN || MODE_MANAGED_HOME_PLUGINS.has(plugin.name)

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
        {plugin.loadFailed ? (
          <p className="mt-1 text-xs text-text-secondary" role="status">
            {t('workbench.core_dsh_plugins_load_failed')}
          </p>
        ) : null}
        {modeManaged ? (
          <p className="mt-1 text-xs text-text-secondary">
            {t('workbench.core_dsh_plugins_managed_by_mode', '由“设置 → 通用 → 模式”管理')}
          </p>
        ) : null}
      </div>
      {!plugin.immutable && !modeManaged ? (
        <div className="flex items-center gap-2">
          <ControlButton
            variant="outline"
            size="sm"
            type="button"
            aria-label={t('workbench.core_dsh_plugins_update_named', '更新 {{name}}', {
              name: plugin.displayName,
            })}
            data-testid={`core-dsh-plugin-update-${plugin.name}`}
            disabled={operation !== null || !plugin.canUpdate}
            onClick={onUpdate}
          >
            {updating && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}
            {t('workbench.plugins_update', '更新')}
          </ControlButton>
          <ControlButton
            variant="outline"
            size="sm"
            type="button"
            data-testid={`core-dsh-plugin-toggle-${plugin.name}`}
            disabled={operation !== null || !plugin.canToggle}
            onClick={onToggle}
          >
            {plugin.enabled
              ? t('workbench.core_dsh_plugins_disable', '停用')
              : t('workbench.core_dsh_plugins_enable', '启用')}
          </ControlButton>
          <DeleteIconButton
            type="button"
            aria-label={t('workbench.core_dsh_plugins_uninstall_named', '卸载 {{name}}', {
              name: plugin.displayName,
            })}
            data-testid={`core-dsh-plugin-uninstall-${plugin.name}`}
            disabled={operation !== null || !plugin.canUninstall}
            onClick={onUninstall}
          />
        </div>
      ) : null}
    </article>
  )
}
