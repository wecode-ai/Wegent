import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import type { RefreshWorkLists } from '@/features/workbench/workbenchContextTypes'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { deviceSupportsManagedWorktrees } from '@/lib/worktree-availability'
import type {
  DeviceInfo,
  RuntimeManagedWorktree,
  RuntimeTaskAddress,
  RuntimeWorktreeConversation,
  RuntimeWorktreeSettings,
} from '@/types/api'
import { getIdleResourceSnapshot, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { useDeadlineExpired } from '@wegent/collaboration/clock'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { CircleCheck, Loader2, RefreshCw, X } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import {
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
} from './settings-ui'
import {
  createWorktreeSettingsResource,
  type WorktreeSettingsChange,
} from './worktreeSettingsResource'

type RuntimeWorkApi = NonNullable<WorkbenchServices['runtimeWorkApi']>

interface WorktreesSettingsPageProps {
  api?: RuntimeWorkApi
  devices?: Array<
    Pick<DeviceInfo, 'device_id' | 'name' | 'status' | 'device_type' | 'runtime_features'>
  >
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void>
  onRefreshWorkLists?: RefreshWorkLists
  onLeaveSettings?: () => void
}

function groupWorktrees(items: RuntimeManagedWorktree[]) {
  const groups = new Map<
    string,
    { name: string; sourcePath?: string | null; items: RuntimeManagedWorktree[] }
  >()
  items.forEach(item => {
    const key = item.sourcePath || item.repositoryName
    const existing = groups.get(key)
    if (existing) {
      existing.items.push(item)
    } else {
      groups.set(key, { name: item.repositoryName, sourcePath: item.sourcePath, items: [item] })
    }
  })
  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...group }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function WorktreeRow({
  item,
  busy,
  openingTaskId,
  onDelete,
  onRestore,
  onOpenConversation,
}: {
  item: RuntimeManagedWorktree
  busy: boolean
  openingTaskId: string | null
  onDelete: () => void
  onRestore: () => void
  onOpenConversation?: (conversation: RuntimeWorktreeConversation) => void
}) {
  const { t } = useTranslation('common')
  return (
    <div data-testid="worktree-row" className="flex flex-col gap-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium text-text-primary">
              {t('workbench.worktrees_row_title')}
            </div>
          </div>
          <div className="mt-1 truncate text-xs text-text-secondary" title={item.path}>
            {item.path}
          </div>
          {item.lastError && (
            <div
              data-testid="worktree-error"
              role="alert"
              className="mt-1 break-words text-xs text-destructive wework:text-red-600"
            >
              {item.lastError}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={`${item.state === 'restorable' ? 'restore' : 'delete'}-worktree-button-${item.worktreeId}`}
            onClick={item.state === 'restorable' ? onRestore : onDelete}
            disabled={busy}
            className={
              item.state === 'restorable'
                ? 'inline-flex h-8 items-center gap-1.5 rounded-md bg-muted px-3 text-sm font-medium text-text-primary hover:bg-background disabled:opacity-50'
                : 'inline-flex h-8 items-center gap-1.5 rounded-md bg-destructive/10 px-3 text-sm font-medium text-destructive hover:bg-destructive/15 disabled:opacity-50 wework:bg-red-500/10 wework:text-red-500 wework:hover:bg-red-500/15'
            }
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t(
              item.state === 'restorable'
                ? 'workbench.worktrees_restore'
                : 'workbench.worktrees_delete'
            )}
          </ControlButton>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-text-secondary">{t('workbench.worktrees_conversations')}</div>
        {item.conversations.length === 0 ? (
          <div className="text-xs text-text-secondary">
            {t('workbench.worktrees_no_conversations')}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {item.conversations.map(conversation => (
              <ControlButton
                variant="unstyled"
                type="button"
                key={`${conversation.deviceId}-${conversation.taskId}`}
                data-testid="worktree-linked-task"
                onClick={() => onOpenConversation?.(conversation)}
                disabled={!onOpenConversation || openingTaskId === conversation.taskId}
                className="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-sm text-text-primary hover:bg-muted hover:text-text-primary/80 disabled:cursor-default disabled:opacity-60"
              >
                {openingTaskId === conversation.taskId && (
                  <Loader2 className="mr-2 h-3.5 w-3.5 shrink-0 animate-spin" />
                )}
                <span className="truncate">{conversation.title}</span>
              </ControlButton>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

type WorktreeSource = ReturnType<typeof createWorktreeSettingsResource>
type WorktreeFailure = {
  cause: unknown
  key: 'load' | 'save' | 'delete' | 'restore' | 'open_conversation'
}
function initialWorktreeUI(source: WorktreeSource) {
  return {
    source,
    baseline: undefined as RuntimeWorktreeSettings | undefined,
    rootDraft: undefined as string | undefined,
    keepCountDraft: undefined as string | undefined,
    saving: false,
    busyPaths: new Set<string>(),
    openingTaskId: null as string | null,
    pendingDisableCleanup: false,
    pendingRecycle: null as RuntimeManagedWorktree | null,
    savedReceipt: null as { message: string; deadline: number } | null,
    error: null as WorktreeFailure | null,
  }
}
const EMPTY_WORKTREES: RuntimeManagedWorktree[] = []

export function WorktreesSettingsPage({
  api,
  devices = [],
  onOpenRuntimeTask,
  onRefreshWorkLists,
  onLeaveSettings,
}: WorktreesSettingsPageProps) {
  const { t } = useTranslation('common')
  const availableDevices = useMemo(
    () =>
      devices.filter(
        device =>
          (device.status === 'online' || device.status === 'busy') &&
          deviceSupportsManagedWorktrees(device)
      ),
    [devices]
  )
  const [deviceId, setDeviceId] = useState(availableDevices[0]?.device_id ?? '')
  const selectedDeviceId = availableDevices.some(device => device.device_id === deviceId)
    ? deviceId
    : (availableDevices[0]?.device_id ?? '')
  const source = useMemo(
    () => createWorktreeSettingsResource(api, selectedDeviceId),
    [api, selectedDeviceId]
  )
  const settingsQuery = useSyncExternalStore(
    source?.settings.subscribe ?? subscribeIdleResource,
    source?.settings.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const listQuery = useSyncExternalStore(
    source?.items.subscribe ?? subscribeIdleResource,
    source?.items.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const settings = settingsQuery.data
  const items = listQuery.data ?? EMPTY_WORKTREES
  const loading = !!source && !listQuery.settled
  const [ui, setUI] = useState(() => initialWorktreeUI(source))
  if (ui.source !== source) setUI(initialWorktreeUI(source))
  else if (ui.baseline !== settings)
    setUI({
      ...ui,
      baseline: settings,
      rootDraft: ui.rootDraft === ui.baseline?.worktreeRoot ? undefined : ui.rootDraft,
      keepCountDraft:
        ui.keepCountDraft === String(ui.baseline?.keepCount) ? undefined : ui.keepCountDraft,
    })
  const rootDraft = ui.rootDraft ?? settings?.worktreeRoot ?? ''
  const keepCountDraft = ui.keepCountDraft ?? String(settings?.keepCount ?? 15)
  const { saving, openingTaskId, pendingDisableCleanup, pendingRecycle } = ui
  const busyPath = ui.busyPaths.values().next().value ?? null
  const failure =
    ui.error ??
    (settingsQuery.status === 'error'
      ? { cause: settingsQuery.error, key: 'load' as const }
      : listQuery.status === 'error'
        ? { cause: listQuery.error, key: 'load' as const }
        : null)
  const error = failure
    ? failure.cause instanceof Error && failure.cause.message
      ? failure.cause.message
      : t('workbench.worktrees_' + failure.key + '_failed')
    : null
  const expired = useDeadlineExpired(ui.savedReceipt?.deadline)
  const savedNotice = ui.savedReceipt && !expired ? ui.savedReceipt.message : null
  const patchUI = useCallback(
    (patch: Partial<typeof ui>) => {
      setUI(current => (current.source === source ? { ...current, ...patch } : current))
    },
    [source]
  )
  const load = useCallback(async () => {
    if (!source?.active()) return
    patchUI({ error: null })
    await source.reload()
  }, [source, patchUI])

  const updateSettings = useCallback(
    async (patch: WorktreeSettingsChange, successNotice?: string) => {
      if (!source?.active()) return false
      patchUI({ saving: true, error: null })
      try {
        const receipt = await source.updateSettings(patch)
        if (!source.active()) return false
        setUI(current =>
          current.source === source
            ? {
                ...current,
                rootDraft:
                  patch.worktreeRoot !== undefined && current.rootDraft === patch.worktreeRoot
                    ? undefined
                    : current.rootDraft,
                keepCountDraft:
                  patch.keepCount !== undefined &&
                  current.keepCountDraft === String(patch.keepCount)
                    ? undefined
                    : current.keepCountDraft,
                savedReceipt: successNotice
                  ? { message: successNotice, deadline: receipt.savedAt + 2000 }
                  : current.savedReceipt,
              }
            : current
        )
        return true
      } catch (cause) {
        patchUI({ error: { cause, key: 'save' } })
        return false
      } finally {
        patchUI({ saving: source.hasPendingSettings() })
      }
    },
    [source, patchUI]
  )
  const commitKeepCount = useCallback(() => {
    if (!settings) return
    const keepCount = Math.max(1, Number(keepCountDraft) || 1)
    patchUI({ keepCountDraft: String(keepCount) })
    if (keepCount === settings.keepCount) return
    void updateSettings({ keepCount }, t('workbench.worktrees_saved_limit'))
  }, [keepCountDraft, settings, patchUI, t, updateSettings])

  const mutateWorktree = async (item: RuntimeManagedWorktree, kind: 'delete' | 'restore') => {
    if (!source?.active() || source.actions.has(item.path)) return
    source.actions.add(item.path)
    patchUI({ busyPaths: new Set(source.actions), error: null })
    const finish = (failure?: WorktreeFailure) =>
      setUI(current =>
        current.source === source
          ? {
              ...current,
              pendingRecycle:
                current.pendingRecycle?.path === item.path ? null : current.pendingRecycle,
              error: failure ?? current.error,
            }
          : current
      )
    try {
      const response = await (kind === 'delete'
        ? source.api.deleteWorktree({
            deviceId: item.deviceId,
            path: item.path,
            preserveSnapshot: true,
          })
        : source.api.restoreWorktree({ deviceId: item.deviceId, path: item.path }))
      if (!source.active()) return
      if (!response.success) throw new Error(t('workbench.worktrees_' + kind + '_failed'))
      finish()
      await Promise.all([source.items.reload(), onRefreshWorkLists?.()])
    } catch (cause) {
      finish({ cause, key: kind })
    } finally {
      source.actions.delete(item.path)
      patchUI({ busyPaths: new Set(source.actions) })
    }
  }
  const groups = useMemo(
    () =>
      groupWorktrees(items.filter(item => ['active', 'restorable', 'failed'].includes(item.state))),
    [items]
  )
  const unavailable = !api || availableDevices.length === 0

  const openConversation = async (conversation: RuntimeWorktreeConversation) => {
    if (!source?.active() || !onOpenRuntimeTask) return
    patchUI({ openingTaskId: conversation.taskId, error: null })
    try {
      await onRefreshWorkLists?.()
      if (!source.active()) return
      await onOpenRuntimeTask(conversation)
      if (source.active()) onLeaveSettings?.()
    } catch (cause) {
      patchUI({ error: { cause, key: 'open_conversation' } })
    } finally {
      patchUI({ openingTaskId: null })
    }
  }

  return (
    <SettingsPage data-testid="worktrees-settings-page">
      <SettingsPageHeader title={t('workbench.worktrees_title')} />

      {availableDevices.length > 1 && (
        <label className="block text-sm text-text-secondary">
          <span className="mb-2 block">{t('workbench.worktrees_device')}</span>
          <SelectRoot
            value={normalizeSelectValue(selectedDeviceId)}
            onValueChange={selectedValue => {
              if (selectedValue !== null) return setDeviceId(selectedValue)
            }}
          >
            <SelectTrigger data-testid="worktrees-device-select" className="w-full max-w-[360px]" />
            <SelectContent>
              {availableDevices.map(device => (
                <SelectItem key={device.device_id} value={String(device.device_id)}>
                  {device.name}
                </SelectItem>
              ))}
            </SelectContent>
          </SelectRoot>
        </label>
      )}

      {unavailable ? (
        <div className="mt-8 rounded-lg border border-border bg-surface px-4 py-4 text-sm text-text-secondary">
          {t('workbench.worktrees_device_unavailable')}
        </div>
      ) : (
        settings && (
          <SettingsGroup className={availableDevices.length > 1 ? 'mt-6' : ''}>
            <SettingsRow
              label={t('workbench.worktrees_root')}
              description={t('workbench.worktrees_root_description')}
              children={
                <ControlInput
                  data-testid="worktrees-root-input"
                  value={rootDraft}
                  onChange={event => patchUI({ rootDraft: event.target.value })}
                  onBlur={() => {
                    if (rootDraft !== settings.worktreeRoot)
                      void updateSettings(
                        { worktreeRoot: rootDraft },
                        t('workbench.worktrees_saved_root')
                      )
                  }}
                  placeholder={t('workbench.worktrees_default')}
                  disabled={saving}
                  className="w-56 max-sm:w-full"
                />
              }
            />
            <SettingsRow
              label={t('workbench.worktrees_auto_cleanup')}
              description={t('workbench.worktrees_auto_cleanup_description')}
              children={
                <SettingsSwitch
                  checked={settings.autoCleanupEnabled}
                  data-testid="worktrees-auto-cleanup-switch"
                  onCheckedChange={checked => {
                    if (!checked) {
                      patchUI({ pendingDisableCleanup: true })
                    } else {
                      void updateSettings(
                        { autoCleanupEnabled: true },
                        t('workbench.worktrees_saved_cleanup')
                      )
                    }
                  }}
                  disabled={saving}
                  aria-label={t('workbench.worktrees_auto_cleanup')}
                />
              }
            />
            <SettingsRow
              label={t('workbench.worktrees_keep_count')}
              description={t('workbench.worktrees_keep_count_description')}
              children={
                <div className="ml-6 max-sm:ml-0">
                  <ControlInput
                    type="number"
                    min={1}
                    data-testid="worktrees-keep-count-input"
                    value={keepCountDraft}
                    onChange={event => patchUI({ keepCountDraft: event.target.value })}
                    onBlur={commitKeepCount}
                    onKeyDown={event => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                    disabled={saving || !settings.autoCleanupEnabled}
                    className="w-24"
                  />
                </div>
              }
            />
          </SettingsGroup>
        )
      )}

      {error && (
        <div className="mt-5 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive wework:border-red-500/20 wework:bg-red-500/10 wework:text-red-500">
          {error}
        </div>
      )}

      <section className="mt-10">
        {loading ? (
          <div className="py-10 text-center text-sm text-text-secondary">{t('common.loading')}</div>
        ) : groups.length === 0 ? (
          <div>
            <div className="mb-3 flex justify-end">
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="worktrees-refresh-button"
                onClick={() => void load()}
                disabled={unavailable}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-50"
                aria-label={t('workbench.worktrees_refresh')}
              >
                <RefreshCw className="h-4 w-4" />
              </ControlButton>
            </div>
            {listQuery.data !== undefined && listQuery.status !== 'error' && (
              <div className="rounded-2xl border border-border bg-surface px-4 py-4 text-sm text-text-secondary">
                {t('workbench.worktrees_empty_description')}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-10">
            {groups.map((group, index) => (
              <div key={group.key} data-testid="worktree-project-group">
                <div
                  data-testid="worktree-project-header"
                  className="mb-4 flex min-w-0 items-center justify-between gap-3"
                >
                  <h3
                    className="truncate text-sm text-text-primary"
                    title={group.sourcePath || group.name}
                  >
                    {group.sourcePath || group.name}
                  </h3>
                  {index === 0 && (
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      data-testid="worktrees-refresh-button"
                      onClick={() => void load()}
                      disabled={unavailable}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-50"
                      aria-label={t('workbench.worktrees_refresh')}
                    >
                      <RefreshCw className="h-4 w-4" />
                    </ControlButton>
                  )}
                </div>
                <SettingsGroup className="bg-background">
                  {group.items.map(item => (
                    <WorktreeRow
                      key={`${item.deviceId}-${item.path}`}
                      item={item}
                      busy={ui.busyPaths.has(item.path)}
                      openingTaskId={openingTaskId}
                      onDelete={() => patchUI({ pendingRecycle: item })}
                      onRestore={() => void mutateWorktree(item, 'restore')}
                      onOpenConversation={
                        onOpenRuntimeTask
                          ? conversation => void openConversation(conversation)
                          : undefined
                      }
                    />
                  ))}
                </SettingsGroup>
              </div>
            ))}
          </div>
        )}
      </section>

      {savedNotice && (
        <div
          role="status"
          data-testid="worktrees-saved-notice"
          className="fixed left-1/2 top-5 z-[1100] flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-primary/35 bg-[rgb(var(--color-sidebar-active))] px-5 py-3 text-sm font-medium text-text-primary shadow-lg"
        >
          <CircleCheck className="h-5 w-5 text-primary" />
          <span>{savedNotice}</span>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="dismiss-worktrees-saved-notice-button"
            onClick={() => patchUI({ savedReceipt: null })}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary"
            aria-label={t('workbench.worktrees_dismiss_saved_notice')}
          >
            <X className="h-4 w-4" />
          </ControlButton>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(pendingRecycle)}
        title={t('workbench.worktrees_delete')}
        description={t('workbench.worktrees_recycle_description')}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('workbench.worktrees_delete')}
        confirmTestId="confirm-recycle-worktree-button"
        destructive
        pending={Boolean(busyPath)}
        onClose={() => patchUI({ pendingRecycle: null })}
        onConfirm={() => {
          if (pendingRecycle) void mutateWorktree(pendingRecycle, 'delete')
        }}
      />
      {pendingDisableCleanup && (
        <div
          className="fixed inset-0 z-modal flex items-center justify-center bg-black/45 px-4"
          onClick={event => {
            if (!saving && event.target === event.currentTarget)
              patchUI({ pendingDisableCleanup: false })
          }}
        >
          <DialogSurface
            onClose={() => {
              if (!saving) patchUI({ pendingDisableCleanup: false })
            }}
            render={
              <div
                data-testid="disable-worktree-cleanup-dialog"
                className="w-full max-w-[640px] rounded-[28px] border border-border bg-popover px-8 py-7 shadow-[0_24px_64px_rgba(0,0,0,0.34)]"
              />
            }
          >
            <h2 className="heading-base text-text-primary">
              {t('workbench.worktrees_disable_cleanup_title')}
            </h2>
            <p className="mt-5 text-sm leading-7 text-text-secondary">
              {t('workbench.worktrees_disable_cleanup_description')}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="keep-worktree-cleanup-button"
                onClick={() => patchUI({ pendingDisableCleanup: false })}
                disabled={saving}
                className="h-10 rounded-xl px-5 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
              >
                {t('workbench.worktrees_keep_cleanup_enabled')}
              </ControlButton>
              <ControlButton
                variant="destructive"
                size="sm"
                type="button"
                data-testid="disable-worktree-cleanup-button"
                onClick={() => {
                  void updateSettings(
                    { autoCleanupEnabled: false },
                    t('workbench.worktrees_saved_cleanup')
                  ).then(success => {
                    if (success) patchUI({ pendingDisableCleanup: false })
                  })
                }}
                disabled={saving}
              >
                {t('workbench.worktrees_disable_cleanup')}
              </ControlButton>
            </div>
          </DialogSurface>
        </div>
      )}
    </SettingsPage>
  )
}
