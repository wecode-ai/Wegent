import { Loader2, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { createLocalAppServices } from '@/api/local/localServices'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { WORKBENCH_CLOUD_ARCHIVES_CHANGED_EVENT } from '@/features/workbench/workbenchCloudDataEvents'
import { useTranslation } from '@/hooks/useTranslation'
import {
  getArchivedBulkDeleteProgress,
  hasArchivedBulkDeletedKey,
  notifyArchivedBulkDeleteDeleted,
  setArchivedBulkDeleteProgress,
  subscribeArchivedBulkDeleteDeleted,
  subscribeArchivedBulkDeleteProgress,
  type ArchivedBulkDeleteProgress,
} from './archivedConversationsSettingsState'
import {
  ArchivedConversationGroups,
  ArchivedConversationsFilters,
  type ArchivedProjectGroup,
  type ArchivedSortFilter,
  type ArchivedSourceFilter,
} from './ArchivedConversationsSettingsContent'
import { SettingsPage, SettingsPageHeader } from './settings-ui'
import type { ArchivedConversationItem } from '@/types/api'

type PendingDelete =
  | { type: 'single'; item: ArchivedConversationItem }
  | { type: 'project'; projectName: string; items: ArchivedConversationItem[] }
  | { type: 'all'; items: ArchivedConversationItem[] }

type RuntimeWorkApi = NonNullable<WorkbenchServices['runtimeWorkApi']>

interface ArchivedConversationsSettingsPageProps {
  api?: RuntimeWorkApi
  onOpenRuntimeTask?: (address: ReturnType<typeof archivedConversationAddress>) => Promise<void>
  onRefreshWorkLists?: () => Promise<void>
  onLeaveSettings?: () => void
}

const ARCHIVED_DELETE_BATCH_SIZE = 5
const ARCHIVED_DELETE_MAX_VERIFY_ROUNDS = 5

interface DeleteArchivedConversationDialogProps {
  pendingDelete: PendingDelete
  submitting: boolean
  progress?: { completed: number; total: number } | null
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

function itemAddressKey(item: ArchivedConversationItem) {
  return `${item.deviceId}\0${item.workspacePath}\0${item.taskId}`
}

function itemProjectKey(item: ArchivedConversationItem) {
  if (item.projectId) return `project:${item.projectId}`
  return item.projectName || item.projectKey || item.workspacePath
}

function chunkItems<T>(items: T[], size: number) {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function archivedConversationAddress(item: ArchivedConversationItem) {
  return {
    deviceId: item.deviceId,
    workspacePath: item.workspacePath,
    taskId: item.taskId,
    ...(item.threadId ? { threadId: item.threadId } : {}),
    ...(item.runtimeHandle ? { runtimeHandle: item.runtimeHandle } : {}),
  }
}

function projectDisplayName(item: ArchivedConversationItem, fallback: string) {
  const explicitName = item.projectName?.trim()
  if (explicitName) return explicitName
  const normalizedPath = item.workspacePath.replace(/[\\/]+$/, '')
  return normalizedPath.split(/[\\/]/).filter(Boolean).at(-1) || fallback
}

function groupItems(items: ArchivedConversationItem[], fallbackProjectName: string) {
  const groups = new Map<string, { name: string; items: ArchivedConversationItem[] }>()
  items.forEach(item => {
    const key = itemProjectKey(item)
    const existing = groups.get(key)
    if (existing) {
      existing.items.push(item)
      return
    }
    groups.set(key, {
      name: projectDisplayName(item, fallbackProjectName),
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

function cleanupErrorsFromResults(results: Record<string, unknown>[]) {
  return results
    .flatMap(result => {
      const cleanup = result.cleanup as
        | { errorCount?: number; items?: Array<{ error?: string | null }> }
        | undefined
      if (!cleanup || !cleanup.errorCount || !Array.isArray(cleanup.items)) return []
      return cleanup.items.map(item => item.error).filter(Boolean)
    })
    .slice(0, 3)
    .join('; ')
}

function sortItems(items: ArchivedConversationItem[], sort: ArchivedSortFilter) {
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
  progress,
  onCancel,
  onConfirm,
}: DeleteArchivedConversationDialogProps) {
  const { t } = useTranslation('common')
  const isBulkDelete = pendingDelete.type !== 'single'
  const title =
    pendingDelete.type === 'all'
      ? t('workbench.archived_bulk_delete_dialog_title', '删除全部已归档任务?')
      : pendingDelete.type === 'project'
        ? t('workbench.archived_project_delete_dialog_title', '删除此项目中的全部任务?')
        : t('workbench.archived_delete_dialog_title', '删除已归档任务?')
  const description =
    pendingDelete.type === 'all'
      ? t('workbench.archived_bulk_delete_dialog_desc', '这将永久删除全部已归档任务')
      : pendingDelete.type === 'project'
        ? t(
            'workbench.archived_project_delete_dialog_desc',
            '这将永久删除“{{project}}”中的 {{count}} 个已归档任务',
            {
              project: pendingDelete.projectName,
              count: pendingDelete.items.length,
            }
          )
        : t('workbench.archived_delete_dialog_desc', '这将永久删除已归档任务')
  const confirmLabel =
    pendingDelete.type === 'all'
      ? t('workbench.archived_bulk_delete', '删除全部')
      : t('workbench.archived_delete', '删除')
  const testId =
    pendingDelete.type === 'all'
      ? 'archived-bulk-delete-confirm-dialog'
      : pendingDelete.type === 'project'
        ? 'archived-project-delete-confirm-dialog'
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
        <h2 id={`${testId}-title`} className="heading-base tracking-normal">
          {title}
        </h2>
        <p className="mt-5 text-sm leading-6 text-text-secondary">{description}</p>
        {isBulkDelete && progress && (
          <div
            data-testid="archived-bulk-delete-progress"
            className="mt-5 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-secondary"
          >
            {t('workbench.archived_bulk_delete_progress', '已删除 {{completed}} / {{total}}', {
              completed: progress.completed,
              total: progress.total,
            })}
          </div>
        )}
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

export function ArchivedConversationsSettingsPage({
  api: injectedApi,
  onOpenRuntimeTask,
  onRefreshWorkLists,
  onLeaveSettings,
}: ArchivedConversationsSettingsPageProps = {}) {
  const { t } = useTranslation('common')
  const [items, setItems] = useState<ArchivedConversationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [source, setSource] = useState<ArchivedSourceFilter>('all')
  const [sort, setSort] = useState<ArchivedSortFilter>('updated')
  const [projectKey, setProjectKey] = useState('all')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [bulkDeleteProgress, setBulkDeleteProgress] = useState<ArchivedBulkDeleteProgress | null>(
    getArchivedBulkDeleteProgress()
  )
  const [lastUnarchived, setLastUnarchived] = useState<ArchivedConversationItem | null>(null)

  const api = useMemo(() => injectedApi ?? createSettingsRuntimeWorkApi(), [injectedApi])

  const loadArchivedConversations = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await api.listArchivedConversations()
      setItems(response.items.filter(item => !hasArchivedBulkDeletedKey(itemAddressKey(item))))
      setOperationError(null)
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : ''
      setError(
        message
          ? t(
              'workbench.archived_conversations_load_failed_detail',
              '加载已归档任务失败：{{message}}',
              { message }
            )
          : t('workbench.archived_conversations_load_failed', '加载已归档任务失败')
      )
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

  useEffect(() => {
    const handleCloudArchivesChanged = () => {
      void loadArchivedConversations()
    }
    window.addEventListener(WORKBENCH_CLOUD_ARCHIVES_CHANGED_EVENT, handleCloudArchivesChanged)
    return () =>
      window.removeEventListener(WORKBENCH_CLOUD_ARCHIVES_CHANGED_EVENT, handleCloudArchivesChanged)
  }, [loadArchivedConversations])

  useEffect(() => subscribeArchivedBulkDeleteProgress(setBulkDeleteProgress), [])

  useEffect(
    () =>
      subscribeArchivedBulkDeleteDeleted(deletedKeys => {
        setItems(currentItems =>
          currentItems.filter(item => !deletedKeys.has(itemAddressKey(item)))
        )
      }),
    []
  )

  const filteredItemsBeforeProject = useMemo(() => {
    return items.filter(item => {
      if (source !== 'all' && item.source !== source) return false
      return matchesSearch(item, search)
    })
  }, [items, search, source])

  const projectGroups = useMemo(() => {
    const groups = new Map<string, { key: string; name: string; count: number }>()
    items.forEach(item => {
      const key = itemProjectKey(item)
      const existing = groups.get(key)
      if (existing) {
        existing.count += 1
        return
      }
      groups.set(key, {
        key,
        name: projectDisplayName(item, t('workbench.archived_no_project', '无项目')),
        count: 1,
      })
    })
    return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name))
  }, [items, t])

  const visibleItems = useMemo(() => {
    const projectItems =
      projectKey === 'all'
        ? filteredItemsBeforeProject
        : filteredItemsBeforeProject.filter(item => itemProjectKey(item) === projectKey)
    return sortItems(projectItems, sort)
  }, [filteredItemsBeforeProject, projectKey, sort])

  const groupedItems = useMemo<ArchivedProjectGroup[]>(() => {
    const fallbackProjectName = t('workbench.archived_no_project', '无项目')
    if (projectKey === 'all') return groupItems(visibleItems, fallbackProjectName)
    return [
      {
        key: projectKey,
        name:
          projectGroups.find(project => project.key === projectKey)?.name ?? fallbackProjectName,
        items: visibleItems,
      },
    ]
  }, [projectGroups, projectKey, t, visibleItems])
  const hasArchivedItems = items.length > 0
  const bulkDeleteRunning = bulkDeleteProgress?.running === true

  const handleUnarchive = async (item: ArchivedConversationItem) => {
    const key = `unarchive:${item.id}`
    setBusyKey(key)
    setError(null)
    try {
      await api.unarchiveConversation(archivedConversationAddress(item))
      await onRefreshWorkLists?.()
      setLastUnarchived(item)
      await loadArchivedConversations()
    } catch (unarchiveError) {
      const message = unarchiveError instanceof Error ? unarchiveError.message : ''
      setError(
        message
          ? t('workbench.archived_unarchive_failed_detail', { message })
          : t('workbench.archived_unarchive_failed')
      )
    } finally {
      setBusyKey(null)
    }
  }

  const openLastUnarchived = async () => {
    if (!lastUnarchived || !onOpenRuntimeTask) return
    setBusyKey(`open:${lastUnarchived.id}`)
    setError(null)
    try {
      await onRefreshWorkLists?.()
      await onOpenRuntimeTask(archivedConversationAddress(lastUnarchived))
      onLeaveSettings?.()
    } catch (openError) {
      const message = openError instanceof Error ? openError.message : ''
      setError(
        message
          ? t('workbench.archived_open_failed_detail', { message })
          : t('workbench.archived_open_failed')
      )
    } finally {
      setBusyKey(null)
    }
  }

  const handleDelete = (item: ArchivedConversationItem) => {
    setPendingDelete({ type: 'single', item })
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    if (pendingDelete.type !== 'single' && pendingDelete.items.length === 0) return

    if (pendingDelete.type !== 'single') {
      let deleteItems = pendingDelete.items
      const targetKeys = new Set(deleteItems.map(itemAddressKey))
      setPendingDelete(null)
      setArchivedBulkDeleteProgress({ completed: 0, total: deleteItems.length, running: true })
      try {
        const cleanupErrors: string[] = []
        let completed = 0
        let total = deleteItems.length
        for (let round = 0; round < ARCHIVED_DELETE_MAX_VERIFY_ROUNDS; round += 1) {
          const localItems = deleteItems.filter(item => item.source === 'local')
          const cloudItems = deleteItems.filter(item => item.source === 'cloud')
          const batches = [
            ...chunkItems(localItems, ARCHIVED_DELETE_BATCH_SIZE),
            ...chunkItems(cloudItems, ARCHIVED_DELETE_BATCH_SIZE),
          ]
          for (const batch of batches) {
            const response = await api.deleteArchivedConversationsBulk({
              items: batch.map(archivedConversationAddress),
            })
            const cleanupText = cleanupErrorsFromResults(response.results)
            if (cleanupText) cleanupErrors.push(cleanupText)
            const deletedTaskIds = new Set(
              response.results
                .filter(result => result.deleted === true)
                .map(result => String(result.taskId || ''))
            )
            const batchDeletedKeys = new Set(
              batch.filter(item => deletedTaskIds.has(item.taskId)).map(itemAddressKey)
            )
            notifyArchivedBulkDeleteDeleted(batchDeletedKeys)
            completed += batch.length
            setArchivedBulkDeleteProgress({
              completed,
              total,
              running: true,
            })
          }

          const refreshed = await api.listArchivedConversations()
          const remainingItems = refreshed.items.filter(
            item => !hasArchivedBulkDeletedKey(itemAddressKey(item))
          )
          setItems(remainingItems)
          const remainingTargetItems = remainingItems.filter(item =>
            targetKeys.has(itemAddressKey(item))
          )
          if (remainingTargetItems.length === 0) break
          deleteItems = remainingTargetItems
          total += remainingTargetItems.length
          setArchivedBulkDeleteProgress({
            completed,
            total,
            running: true,
          })
        }
        if (cleanupErrors.length > 0) {
          setOperationError(
            t('workbench.archived_cleanup_partial_failed', '部分文件清理失败: {{message}}', {
              message: cleanupErrors.slice(0, 3).join('; '),
            })
          )
        }
        setArchivedBulkDeleteProgress({
          completed,
          total,
          running: false,
        })
      } catch (deleteError) {
        const message = deleteError instanceof Error ? deleteError.message : ''
        setOperationError(
          message
            ? t('workbench.archived_bulk_delete_failed_detail', '删除已归档任务失败：{{message}}', {
                message,
              })
            : t('workbench.archived_bulk_delete_failed', '删除已归档任务失败')
        )
        setArchivedBulkDeleteProgress(
          getArchivedBulkDeleteProgress()
            ? { ...getArchivedBulkDeleteProgress()!, running: false }
            : { completed: 0, total: deleteItems.length, running: false }
        )
      }
      return
    }

    const { item } = pendingDelete
    const key = `delete:${item.id}`
    setBusyKey(key)
    try {
      const response = await api.deleteArchivedConversation(archivedConversationAddress(item))
      const cleanupText = cleanupErrorsFromResults([response as unknown as Record<string, unknown>])
      if (cleanupText) {
        setOperationError(
          t('workbench.archived_cleanup_partial_failed', '部分文件清理失败: {{message}}', {
            message: cleanupText,
          })
        )
      }
      setItems(currentItems => currentItems.filter(currentItem => currentItem.id !== item.id))
      setPendingDelete(null)
    } finally {
      setBusyKey(null)
    }
  }

  const handleBulkDelete = () => {
    if (items.length === 0) return
    setPendingDelete({ type: 'all', items })
  }

  const handleProjectDelete = (group: ArchivedProjectGroup) => {
    const projectItems = items.filter(item => itemProjectKey(item) === group.key)
    if (projectItems.length === 0) return
    setPendingDelete({ type: 'project', projectName: group.name, items: projectItems })
  }

  return (
    <SettingsPage data-testid="archived-conversations-settings-page">
      <SettingsPageHeader
        title={t('workbench.archived_conversations_title', '已归档任务')}
        actions={
          hasArchivedItems ? (
            <button
              type="button"
              data-testid="archived-bulk-delete-button"
              onClick={handleBulkDelete}
              disabled={bulkDeleteRunning}
              className="flex h-8 items-center gap-1.5 rounded-md bg-red-500/10 px-2.5 text-sm text-red-500 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-45 max-md:h-11"
            >
              {bulkDeleteRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {t('workbench.archived_bulk_delete', '删除全部')}
            </button>
          ) : undefined
        }
      />

      {lastUnarchived && (
        <div
          data-testid="archived-unarchive-success"
          className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/10 px-4 py-3 text-sm text-text-primary"
        >
          <span>{t('workbench.archived_unarchive_success', { title: lastUnarchived.title })}</span>
          {onOpenRuntimeTask && (
            <button
              type="button"
              data-testid="archived-view-now-button"
              onClick={() => void openLastUnarchived()}
              disabled={busyKey === `open:${lastUnarchived.id}`}
              className="h-8 shrink-0 rounded-md px-3 text-sm font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {t('workbench.archived_view_now')}
            </button>
          )}
        </div>
      )}

      {bulkDeleteProgress && (
        <div
          data-testid="archived-bulk-delete-background-progress"
          className="mt-4 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-text-secondary"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {bulkDeleteProgress.running
                ? t(
                    'workbench.archived_bulk_delete_background_progress',
                    '正在后台删除已归档任务：{{completed}} / {{total}}',
                    {
                      completed: bulkDeleteProgress.completed,
                      total: bulkDeleteProgress.total,
                    }
                  )
                : t(
                    'workbench.archived_bulk_delete_background_done',
                    '已完成删除已归档任务：{{completed}} / {{total}}',
                    {
                      completed: bulkDeleteProgress.completed,
                      total: bulkDeleteProgress.total,
                    }
                  )}
            </span>
            {!bulkDeleteProgress.running && (
              <button
                type="button"
                data-testid="archived-bulk-delete-progress-dismiss-button"
                onClick={() => setArchivedBulkDeleteProgress(null)}
                className="h-8 rounded-md px-3 text-sm text-text-primary hover:bg-muted"
              >
                {t('workbench.archived_bulk_delete_progress_dismiss', '关闭')}
              </button>
            )}
          </div>
        </div>
      )}

      {operationError && (
        <div
          data-testid="archived-operation-error"
          className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-600"
        >
          {operationError}
        </div>
      )}

      {hasArchivedItems && (
        <ArchivedConversationsFilters
          search={search}
          source={source}
          sort={sort}
          projectKey={projectKey}
          projects={projectGroups}
          onSearchChange={setSearch}
          onSourceChange={setSource}
          onSortChange={setSort}
          onProjectChange={setProjectKey}
        />
      )}

      <div className="mt-3">
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
        ) : visibleItems.length === 0 ? (
          <div
            data-testid="archived-empty"
            className="rounded-xl border border-border bg-surface/40 px-5 py-6 text-sm text-text-primary"
          >
            {hasArchivedItems
              ? t('workbench.archived_no_matches', '没有匹配的已归档任务。')
              : t('workbench.archived_empty', '暂无已归档任务。')}
          </div>
        ) : (
          <ArchivedConversationGroups
            groups={groupedItems}
            showHeaders={projectKey === 'all'}
            busyKey={busyKey}
            onDelete={handleDelete}
            onDeleteProject={handleProjectDelete}
            onUnarchive={item => void handleUnarchive(item)}
          />
        )}
      </div>
      {pendingDelete && (
        <DeleteArchivedConversationDialog
          pendingDelete={pendingDelete}
          submitting={busyKey !== null}
          progress={pendingDelete.type !== 'single' ? bulkDeleteProgress : null}
          onCancel={() => {
            if (busyKey === null) setPendingDelete(null)
          }}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </SettingsPage>
  )
}
