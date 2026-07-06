import { Loader2, RotateCw, Search, Trash2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { createLocalAppServices } from '@/api/local/localServices'
import { useTranslation } from '@/hooks/useTranslation'
import type { ArchivedConversationItem, ArchivedConversationsListRequest } from '@/types/api'

type SourceFilter = NonNullable<ArchivedConversationsListRequest['source']>
type SortFilter = NonNullable<ArchivedConversationsListRequest['sort']>
type PendingDelete =
  | { type: 'single'; item: ArchivedConversationItem }
  | { type: 'bulk'; items: ArchivedConversationItem[] }

interface DeleteArchivedConversationDialogProps {
  pendingDelete: PendingDelete
  submitting: boolean
  onCancel: () => void
  onConfirm: () => void
}

function createSettingsRuntimeWorkApi() {
  const api = createLocalAppServices().runtimeWorkApi
  if (!api) {
    throw new Error('Local runtime work API is unavailable')
  }
  return api
}

function itemTestId(item: ArchivedConversationItem) {
  return `${item.deviceId}-${item.taskId}`.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function itemAddressKey(item: ArchivedConversationItem) {
  return `${item.deviceId}\0${item.workspacePath}\0${item.taskId}`
}

function projectOptionKey(group: {
  projectKey?: string | null
  projectId?: number | null
  name: string
}) {
  return group.projectKey || (group.projectId ? `project:${group.projectId}` : group.name)
}

function formatArchivedTime(value?: string | null) {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value))
  } catch {
    return value
  }
}

function groupItems(items: ArchivedConversationItem[]) {
  const groups = new Map<string, { name: string; items: ArchivedConversationItem[] }>()
  items.forEach(item => {
    const key = item.projectKey || item.projectName || item.workspacePath
    const existing = groups.get(key)
    if (existing) {
      existing.items.push(item)
      return
    }
    groups.set(key, {
      name: item.projectName || item.workspacePath,
      items: [item],
    })
  })
  return [...groups.entries()].map(([key, group]) => ({ key, ...group }))
}

function matchesSearch(item: ArchivedConversationItem, query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  return [
    item.title,
    item.projectName,
    item.workspacePath,
    item.taskId,
    item.deviceAddress,
    item.deviceId,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(normalizedQuery)
}

function archivedTimestamp(value?: string | null) {
  if (!value) return 0
  const timestamp = new Date(value).getTime()
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function sortItems(items: ArchivedConversationItem[], sort: SortFilter) {
  const sorted = [...items]
  if (sort === 'alphabetical') {
    return sorted.sort((left, right) => left.title.localeCompare(right.title))
  }
  if (sort === 'created') {
    return sorted.sort(
      (left, right) => archivedTimestamp(right.createdAt) - archivedTimestamp(left.createdAt)
    )
  }
  return sorted.sort(
    (left, right) =>
      archivedTimestamp(right.updatedAt || right.createdAt) -
      archivedTimestamp(left.updatedAt || left.createdAt)
  )
}

function DeleteArchivedConversationDialog({
  pendingDelete,
  submitting,
  onCancel,
  onConfirm,
}: DeleteArchivedConversationDialogProps) {
  const { t } = useTranslation('common')
  const isBulkDelete = pendingDelete.type === 'bulk'
  const title = isBulkDelete
    ? t('workbench.archived_bulk_delete_dialog_title', '删除全部已归档聊天?')
    : t('workbench.archived_delete_dialog_title', '删除已归档聊天?')
  const description = isBulkDelete
    ? t('workbench.archived_bulk_delete_dialog_desc', '这将永久删除全部已归档聊天')
    : t('workbench.archived_delete_dialog_desc', '这将永久删除已归档聊天')
  const confirmLabel = isBulkDelete
    ? t('workbench.archived_bulk_delete', '删除全部')
    : t('workbench.archived_delete', '删除')
  const testId = isBulkDelete
    ? 'archived-bulk-delete-confirm-dialog'
    : 'archived-delete-confirm-dialog'

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/45 px-4"
      onClick={event => {
        if (!submitting && event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        data-testid={testId}
        className="w-full max-w-[520px] rounded-[24px] border border-border bg-popover px-8 py-6 text-text-primary shadow-[0_24px_64px_rgba(0,0,0,0.34)]"
        onClick={event => event.stopPropagation()}
      >
        <h2 id={`${testId}-title`} className="text-xl font-semibold tracking-normal">
          {title}
        </h2>
        <p className="mt-5 text-sm leading-6 text-text-secondary">{description}</p>
        <div className="mt-6 flex justify-end gap-6">
          <button
            type="button"
            data-testid={`${testId}-cancel-button`}
            onClick={onCancel}
            disabled={submitting}
            className="h-10 min-w-[84px] rounded-xl px-4 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid={`${testId}-confirm-button`}
            onClick={onConfirm}
            disabled={submitting}
            className="inline-flex h-10 min-w-[104px] items-center justify-center gap-2 rounded-xl bg-red-500/15 px-5 text-sm font-semibold text-red-500 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

export function ArchivedConversationsSettingsPage() {
  const { t } = useTranslation('common')
  const [items, setItems] = useState<ArchivedConversationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [source, setSource] = useState<SourceFilter>('all')
  const [sort, setSort] = useState<SortFilter>('updated')
  const [projectKey, setProjectKey] = useState('all')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)

  const api = useMemo(() => createSettingsRuntimeWorkApi(), [])

  const loadArchivedConversations = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await api.listArchivedConversations()
      setItems(response.items)
    } catch {
      setError(t('workbench.archived_conversations_load_failed', '加载已归档对话失败'))
    } finally {
      setLoading(false)
    }
  }, [api, t])

  useEffect(() => {
    const loadTimer = window.setTimeout(() => {
      void loadArchivedConversations()
    }, 0)
    return () => window.clearTimeout(loadTimer)
  }, [loadArchivedConversations])

  const filteredItemsBeforeProject = useMemo(() => {
    return items.filter(item => {
      if (source !== 'all' && item.source !== source) return false
      return matchesSearch(item, search)
    })
  }, [items, search, source])

  const projectGroups = useMemo(() => {
    const groups = new Map<
      string,
      { name: string; projectKey?: string | null; projectId?: number | null; count: number }
    >()
    filteredItemsBeforeProject.forEach(item => {
      const key = item.projectKey || item.projectName || item.workspacePath
      const existing = groups.get(key)
      if (existing) {
        existing.count += 1
        return
      }
      groups.set(key, {
        name: item.projectName || item.workspacePath,
        projectKey: item.projectKey,
        projectId: item.projectId,
        count: 1,
      })
    })
    return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name))
  }, [filteredItemsBeforeProject])

  const visibleItems = useMemo(() => {
    const projectItems =
      projectKey === 'all'
        ? filteredItemsBeforeProject
        : filteredItemsBeforeProject.filter(
            item => (item.projectKey || item.projectName) === projectKey
          )
    return sortItems(projectItems, sort)
  }, [filteredItemsBeforeProject, projectKey, sort])

  const groupedItems = useMemo(() => groupItems(visibleItems), [visibleItems])
  const hasArchivedItems = items.length > 0

  const handleUnarchive = async (item: ArchivedConversationItem) => {
    const key = `unarchive:${item.id}`
    setBusyKey(key)
    try {
      await api.unarchiveConversation({
        deviceId: item.deviceId,
        workspacePath: item.workspacePath,
        taskId: item.taskId,
      })
      await loadArchivedConversations()
    } finally {
      setBusyKey(null)
    }
  }

  const handleDelete = (item: ArchivedConversationItem) => {
    setPendingDelete({ type: 'single', item })
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    if (pendingDelete.type === 'bulk' && pendingDelete.items.length === 0) return

    if (pendingDelete.type === 'bulk') {
      const deletedKeys = new Set(pendingDelete.items.map(itemAddressKey))
      setBusyKey('bulk-delete')
      try {
        await api.deleteArchivedConversationsBulk({
          items: pendingDelete.items.map(item => ({
            deviceId: item.deviceId,
            workspacePath: item.workspacePath,
            taskId: item.taskId,
          })),
        })
        setItems(currentItems =>
          currentItems.filter(item => !deletedKeys.has(itemAddressKey(item)))
        )
        setPendingDelete(null)
      } finally {
        setBusyKey(null)
      }
      return
    }

    const { item } = pendingDelete
    const key = `delete:${item.id}`
    setBusyKey(key)
    try {
      await api.deleteArchivedConversation({
        deviceId: item.deviceId,
        workspacePath: item.workspacePath,
        taskId: item.taskId,
      })
      setItems(currentItems => currentItems.filter(currentItem => currentItem.id !== item.id))
      setPendingDelete(null)
    } finally {
      setBusyKey(null)
    }
  }

  const handleBulkDelete = () => {
    if (items.length === 0) return
    setPendingDelete({ type: 'bulk', items })
  }

  return (
    <div
      data-testid="archived-conversations-settings-page"
      className="mx-auto w-full max-w-[920px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-normal text-text-primary">
            {t('workbench.archived_conversations_title', '已归档对话')}
          </h1>
          {hasArchivedItems && (
            <p className="mt-1 text-sm text-text-secondary">
              {t('workbench.archived_conversations_desc', '管理此设备上的归档 Codex 对话。')}
            </p>
          )}
        </div>
        {hasArchivedItems && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="archived-refresh-button"
              onClick={() => void loadArchivedConversations()}
              disabled={loading}
              className="flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RotateCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
              {t('workbench.refresh_worklists', '刷新')}
            </button>
            <button
              type="button"
              data-testid="archived-bulk-delete-button"
              onClick={() => void handleBulkDelete()}
              disabled={items.length === 0 || busyKey === 'bulk-delete'}
              className="flex h-9 items-center gap-2 rounded-md border border-red-200 px-3 text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {busyKey === 'bulk-delete' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {t('workbench.archived_bulk_delete', '删除全部')}
            </button>
          </div>
        )}
      </div>

      {hasArchivedItems && (
        <div className="mt-6 grid gap-3 md:grid-cols-[1fr_150px_170px_190px]">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              data-testid="archived-search-input"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder={t('workbench.archived_search_placeholder', '搜索归档对话')}
              className="h-10 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
            />
          </label>
          <select
            data-testid="archived-source-filter"
            value={source}
            onChange={event => setSource(event.target.value as SourceFilter)}
            className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
          >
            <option value="all">{t('workbench.archived_filter_all', '全部')}</option>
            <option value="local">{t('workbench.archived_filter_local', '本地')}</option>
            <option value="cloud">{t('workbench.archived_filter_cloud', '云端')}</option>
          </select>
          <select
            data-testid="archived-sort-select"
            value={sort}
            onChange={event => setSort(event.target.value as SortFilter)}
            className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
          >
            <option value="updated">{t('workbench.archived_sort_updated', '按更新')}</option>
            <option value="created">{t('workbench.archived_sort_created', '按创建')}</option>
            <option value="alphabetical">{t('workbench.archived_sort_alpha', '按名称')}</option>
          </select>
          <select
            data-testid="archived-project-filter"
            value={projectKey}
            onChange={event => setProjectKey(event.target.value)}
            className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
          >
            <option value="all">{t('workbench.archived_project_all', '全部项目')}</option>
            {projectGroups.map(group => (
              <option key={projectOptionKey(group)} value={projectOptionKey(group)}>
                {group.name} ({group.count})
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="mt-6">
        {loading ? (
          <div
            data-testid="archived-loading"
            className="flex h-40 items-center justify-center text-text-secondary"
          >
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('workbench.loading', '加载中...')}
          </div>
        ) : error ? (
          <div
            data-testid="archived-error"
            className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600"
          >
            {error}
          </div>
        ) : groupedItems.length === 0 ? (
          <div
            data-testid="archived-empty"
            className="rounded-xl border border-border bg-surface/40 px-5 py-6 text-sm text-text-primary"
          >
            {t('workbench.archived_empty', '暂无已归档的聊天。')}
          </div>
        ) : (
          <div className="space-y-6">
            {groupedItems.map(group => (
              <section key={group.key} data-testid={`archived-group-${group.key}`}>
                <div className="mb-2 flex items-center justify-between text-sm">
                  <h2 className="font-medium text-text-primary">{group.name}</h2>
                  <span className="text-xs text-text-muted">{group.items.length}</span>
                </div>
                <div className="divide-y divide-border rounded-md border border-border bg-background">
                  {group.items.map(item => {
                    const suffix = itemTestId(item)
                    const deleteLabel = t('workbench.archived_delete_tooltip', '删除已归档聊天')
                    const rowBusy =
                      busyKey === `delete:${item.id}` || busyKey === `unarchive:${item.id}`
                    return (
                      <div
                        key={item.id}
                        data-testid={`archived-item-${suffix}`}
                        className="group/archive-row flex min-h-[64px] items-center gap-3 px-4 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-text-primary">
                            {item.title}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
                            {item.source !== 'local' && (
                              <span>{item.deviceAddress || item.deviceId}</span>
                            )}
                            <span className="truncate">{item.workspacePath}</span>
                            <span>{formatArchivedTime(item.updatedAt || item.createdAt)}</span>
                          </div>
                        </div>
                        <div
                          className={`flex items-center gap-2 transition-opacity ${
                            rowBusy
                              ? 'opacity-100'
                              : 'opacity-100 md:pointer-events-none md:opacity-0 md:group-hover/archive-row:pointer-events-auto md:group-hover/archive-row:opacity-100 md:group-focus-within/archive-row:pointer-events-auto md:group-focus-within/archive-row:opacity-100'
                          }`}
                        >
                          <div className="group/delete-button relative">
                            <button
                              type="button"
                              data-testid={`archived-delete-button-${suffix}`}
                              aria-label={deleteLabel}
                              title={deleteLabel}
                              onClick={() => void handleDelete(item)}
                              disabled={busyKey !== null}
                              className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
                            >
                              {busyKey === `delete:${item.id}` ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Trash2 className="h-4 w-4" />
                              )}
                            </button>
                            <span className="pointer-events-none absolute bottom-full left-1/2 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-text-primary shadow-sm group-hover/delete-button:block">
                              {deleteLabel}
                            </span>
                          </div>
                          <button
                            type="button"
                            data-testid={`archived-unarchive-button-${suffix}`}
                            onClick={() => void handleUnarchive(item)}
                            disabled={busyKey !== null}
                            className="flex h-9 items-center gap-1.5 rounded-md bg-muted px-3 text-sm text-text-primary hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            {busyKey === `unarchive:${item.id}` ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Undo2 className="h-4 w-4" />
                            )}
                            {t('workbench.archived_unarchive', '取消归档')}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
      {pendingDelete && (
        <DeleteArchivedConversationDialog
          pendingDelete={pendingDelete}
          submitting={busyKey !== null}
          onCancel={() => {
            if (busyKey === null) setPendingDelete(null)
          }}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  )
}
