import { Loader2, MessageSquare, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createHttpClient } from '@/api/http'
import { createProjectApi } from '@/api/projects'
import { getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import { buildTaskRoute, navigateTo } from '@/lib/navigation'
import type {
  ProjectWorktreeDeviceGroup,
  ProjectWorktreeItem,
  ProjectWorktreeListResponse,
} from '@/types/api'

interface PendingDeleteWorktree {
  device: ProjectWorktreeDeviceGroup
  item: ProjectWorktreeItem
}

interface WorktreeRowData {
  device: ProjectWorktreeDeviceGroup
  item: ProjectWorktreeItem
}

interface WorktreeProjectGroup {
  key: string
  name: string
  sourcePath?: string
  rows: WorktreeRowData[]
}

function createSettingsProjectApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createProjectApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

function statusDotClass(status: string) {
  if (status === 'online') return 'bg-primary'
  if (status === 'busy') return 'bg-amber-500'
  return 'bg-text-muted'
}

function getDeviceStatusLabel(
  status: string,
  t: (key: string, fallback: string) => string,
) {
  if (status === 'online') {
    return t('workbench.project_device_status_online', '在线')
  }
  if (status === 'busy') {
    return t('workbench.project_device_status_busy', '忙碌')
  }
  return t('workbench.project_device_status_offline', '离线')
}

function groupWorktreesByProject(
  data: ProjectWorktreeListResponse | null,
): WorktreeProjectGroup[] {
  if (!data) return []

  const groups = new Map<string, WorktreeProjectGroup>()
  data.devices.forEach(device => {
    if (!device.available) return

    device.items.forEach(item => {
      const key = item.project ? `project:${item.project.id}` : `folder:${item.project_name}`
      const existing = groups.get(key)
      if (existing) {
        existing.rows.push({ device, item })
        return
      }

      groups.set(key, {
        key,
        name: item.project?.name ?? item.project_name,
        sourcePath: item.project?.source_path,
        rows: [{ device, item }],
      })
    })
  })

  return [...groups.values()].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
  )
}

function worktreeKey(device: ProjectWorktreeDeviceGroup, item: ProjectWorktreeItem) {
  return `${device.device_id}:${item.worktree_id}:${item.project?.id ?? 'unknown'}`
}

function getUniqueGroupDevices(group: WorktreeProjectGroup): ProjectWorktreeDeviceGroup[] {
  const devices = new Map<string, ProjectWorktreeDeviceGroup>()
  group.rows.forEach(row => {
    devices.set(row.device.device_id, row.device)
  })
  return [...devices.values()]
}

function WorktreeTaskEntry({ item }: { item: ProjectWorktreeItem }) {
  const { t } = useTranslation('common')
  const task = item.task

  if (!task) {
    return (
      <span
        data-testid={`worktree-task-missing-${item.worktree_id}`}
        className="inline-flex h-8 w-44 shrink-0 items-center justify-start truncate text-xs text-text-muted"
        title={t('workbench.worktrees_task_missing_title')}
      >
        {t('workbench.worktrees_task_missing')}
      </span>
    )
  }

  return (
    <button
      type="button"
      data-testid={`worktree-task-link-${item.worktree_id}`}
      onClick={() =>
        navigateTo(buildTaskRoute({ taskId: task.id, projectId: task.project_id }))
      }
      className="inline-flex h-8 w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-left text-xs text-text-secondary hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      title={`${task.title} #${task.id}`}
      aria-label={t('workbench.worktrees_open_task', { title: task.title })}
    >
      <MessageSquare className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{task.title}</span>
    </button>
  )
}

function WorktreeRow({
  row,
  deletingKey,
  onRequestDelete,
}: {
  row: WorktreeRowData
  deletingKey: string | null
  onRequestDelete: (device: ProjectWorktreeDeviceGroup, item: ProjectWorktreeItem) => void
}) {
  const { t } = useTranslation('common')
  const { device, item } = row
  const key = worktreeKey(device, item)

  return (
    <div
      data-testid="worktree-row"
      className="flex min-h-[52px] items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 hover:bg-muted"
      title={item.path}
    >
      <span className="shrink-0 text-sm font-semibold text-text-primary">
        {t('workbench.worktrees_item_title', '工作树')}
      </span>
      <p className="min-w-0 flex-1 truncate font-mono text-sm text-text-secondary">
        {item.path}
      </p>
      <WorktreeTaskEntry item={item} />
      {item.project && (
        <button
          type="button"
          data-testid={`delete-worktree-button-${item.worktree_id}`}
          onClick={() => onRequestDelete(device, item)}
          disabled={deletingKey === key}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t('workbench.worktrees_delete', '删除')}
        >
          {deletingKey === key ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
        </button>
      )}
    </div>
  )
}

function WorktreeProjectGroupSection({
  group,
  deletingKey,
  onRequestDelete,
}: {
  group: WorktreeProjectGroup
  deletingKey: string | null
  onRequestDelete: (device: ProjectWorktreeDeviceGroup, item: ProjectWorktreeItem) => void
}) {
  const { t } = useTranslation('common')
  const devices = getUniqueGroupDevices(group)

  return (
    <section data-testid="worktree-project-group" className="space-y-3">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-text-primary" title={group.name}>
          {group.name}
        </h2>
        <div
          data-testid="worktree-project-metadata"
          className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted"
        >
          {group.sourcePath && (
            <span
              className="min-w-0 max-w-full truncate font-mono"
              title={group.sourcePath}
            >
              {group.sourcePath}
            </span>
          )}
          {devices.map(device => (
            <span
              key={device.device_id}
              data-testid="worktree-device-name"
              className="inline-flex min-w-0 max-w-[18rem] items-center gap-1.5 text-text-secondary"
              title={device.device_name}
            >
              <span className="truncate text-text-muted">{device.device_name}</span>
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(device.device_status)}`}
                aria-hidden="true"
              />
              <span className="shrink-0">
                {getDeviceStatusLabel(device.device_status, t)}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-background">
        {group.rows.map(row => (
          <WorktreeRow
            key={worktreeKey(row.device, row.item)}
            row={row}
            deletingKey={deletingKey}
            onRequestDelete={onRequestDelete}
          />
        ))}
      </div>
    </section>
  )
}

function DeleteWorktreeDialog({
  pendingDelete,
  deleting,
  onCancel,
  onConfirm,
}: {
  pendingDelete: PendingDeleteWorktree
  deleting: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('common')
  const { item } = pendingDelete

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
      onClick={event => {
        if (!deleting && event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        data-testid="confirm-delete-worktree-dialog"
        className="w-full max-w-[440px] rounded-lg border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-red-500/10 text-red-500">
            <Trash2 className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-text-primary">
              {t('workbench.worktrees_delete_title', '删除工作树')}
            </h2>
            <p className="mt-1.5 text-xs leading-5 text-text-secondary">
              {t(
                'workbench.worktrees_delete_desc',
                '将删除这个工作树目录，并一并删除使用该工作树的任务。',
              )}
            </p>
            <p className="mt-2 break-all font-mono text-xs text-text-muted">
              {item.path}
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="cancel-delete-worktree-button"
            onClick={onCancel}
            disabled={deleting}
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="confirm-delete-worktree-button"
            onClick={onConfirm}
            disabled={deleting}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('workbench.worktrees_delete_confirm', '确认删除')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function WorktreesSettingsPage() {
  const { t } = useTranslation('common')
  const [data, setData] = useState<ProjectWorktreeListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteWorktree | null>(null)
  const [deletingKey, setDeletingKey] = useState<string | null>(null)
  const projectGroups = useMemo(() => groupWorktreesByProject(data), [data])

  const loadWorktrees = useCallback(async (refresh = false) => {
    if (refresh) {
      setRefreshing(true)
    } else {
      setLoading(true)
    }
    setError(null)
    try {
      const result = await createSettingsProjectApi().listWorktrees()
      setData(result)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载失败')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => loadWorktrees())
  }, [loadWorktrees])

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete?.item.project) return
    const key = worktreeKey(pendingDelete.device, pendingDelete.item)
    setDeletingKey(key)
    setError(null)
    try {
      await createSettingsProjectApi().deleteWorktree({
        device_id: pendingDelete.device.device_id,
        worktree_id: pendingDelete.item.worktree_id,
        project_id: pendingDelete.item.project.id,
      })
      setPendingDelete(null)
      await loadWorktrees(true)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除失败')
    } finally {
      setDeletingKey(null)
    }
  }, [loadWorktrees, pendingDelete])

  const showEmptyState = !loading && !error && data !== null && projectGroups.length === 0
  const showRows = !loading && !error && projectGroups.length > 0

  return (
    <div data-testid="worktrees-settings-page" className="mx-auto w-full max-w-[960px]">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-normal text-text-primary">
          {t('workbench.worktrees_title', '工作树')}
        </h1>
        <button
          type="button"
          data-testid="worktrees-refresh-button"
          onClick={() => void loadWorktrees(true)}
          disabled={loading || refreshing}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-surface text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t('workbench.worktrees_refresh', '刷新')}
          title={t('workbench.worktrees_refresh', '刷新')}
        >
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </button>
      </div>

      <div className="mt-8">
        {loading && (
          <div className="py-8 text-center text-sm text-text-secondary">
            {t('common.loading', '加载中...')}
          </div>
        )}
        {!loading && error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-500">
            {error}
          </div>
        )}
        {showEmptyState && (
          <div>
            <h2 className="text-sm font-semibold text-text-primary">
              {t('workbench.worktrees_empty', '尚无工作树')}
            </h2>
            <div className="mt-3 rounded-lg border border-border bg-surface px-4 py-3 text-left text-sm text-text-secondary">
              {t(
                'workbench.worktrees_empty_description',
                '创建的工作树将显示在此处。',
              )}
            </div>
          </div>
        )}
        {showRows && (
          <div className="space-y-8">
            {projectGroups.map(group => (
              <WorktreeProjectGroupSection
                key={group.key}
                group={group}
                deletingKey={deletingKey}
                onRequestDelete={(targetDevice, item) =>
                  setPendingDelete({ device: targetDevice, item })
                }
              />
            ))}
          </div>
        )}
      </div>
      {pendingDelete && (
        <DeleteWorktreeDialog
          pendingDelete={pendingDelete}
          deleting={deletingKey === worktreeKey(pendingDelete.device, pendingDelete.item)}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void handleConfirmDelete()}
        />
      )}
    </div>
  )
}
