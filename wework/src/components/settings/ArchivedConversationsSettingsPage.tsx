import { createLocalAppServices } from '@/api/local/localServices'
import { deleteReplyPredictions } from '@/features/reply-predictions/replyPredictionService'
import { unmarkRuntimeConversationArchived } from '@/features/workbench/runtimeConversationCache'
import { WORKBENCH_CLOUD_ARCHIVES_CHANGED_EVENT } from '@/features/workbench/workbenchCloudDataEvents'
import type { RefreshWorkLists } from '@/features/workbench/workbenchContextTypes'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import {
  deleteArchivedLocalHarnessSession,
  notifyLocalHarnessSessionsChanged,
  unarchiveLocalHarnessSession,
} from '@/lib/local-terminal'
import { track } from '@/telemetry/client'
import type { ArchivedConversationItem } from '@/types/api'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Loader2, Trash2 } from 'lucide-react'
import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { itemAddressKey, localHarnessSessionId } from './archivedConversationItems'
import { createArchivedConversationsResource } from './archivedConversationsResource'
import {
  ArchivedConversationGroups,
  ArchivedConversationsFilters,
  type ArchivedProjectGroup,
  type ArchivedSortFilter,
  type ArchivedSourceFilter,
} from './ArchivedConversationsSettingsContent'
import {
  beginArchivedCleanup,
  getArchivedBulkDeleteProgress,
  getArchivedCleanupError,
  hasArchivedBulkDeletedKey,
  hasArchivedCleanupFailedKey,
  notifyArchivedBulkDeleteDeleted,
  setArchivedBulkDeleteProgress,
  subscribeArchivedBulkDeleteProgress,
  subscribeArchivedCleanupError,
} from './archivedConversationsSettingsState'
import { SettingsPage, SettingsPageHeader } from './settings-ui'

type PendingDelete =
  | { type: 'single'; item: ArchivedConversationItem }
  | { type: 'project'; projectName: string; items: ArchivedConversationItem[] }
  | { type: 'all'; items: ArchivedConversationItem[] }

type RuntimeWorkApi = NonNullable<WorkbenchServices['runtimeWorkApi']>

interface ArchivedConversationsSettingsPageProps {
  api?: RuntimeWorkApi
  onOpenRuntimeTask?: (address: ReturnType<typeof archivedConversationAddress>) => Promise<void>
  onRefreshWorkLists?: RefreshWorkLists
  onLeaveSettings?: () => void
}

const ARCHIVED_DELETE_BATCH_SIZE = 5
const ARCHIVED_DELETE_MAX_VERIFY_ROUNDS = 5

interface DeleteArchivedConversationDialogProps {
  pendingDelete: PendingDelete
  submitting: boolean
  progress?: { completed: number; total: number } | null
  error?: string | null
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

function archivedTimestamp(value?: string | number | null) {
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
  error,
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
      <DialogSurface
        onClose={() => {
          if (!submitting) onCancel()
        }}
        render={
          <div
            aria-labelledby={`${testId}-title`}
            data-testid={testId}
            className="w-full max-w-[520px] rounded-[24px] border border-border bg-popover px-8 py-6 text-text-primary shadow-[0_24px_64px_rgba(0,0,0,0.34)]"
            onClick={event => event.stopPropagation()}
          />
        }
      >
        <h2 id={`${testId}-title`} className="heading-base tracking-normal">
          {title}
        </h2>
        <p className="mt-5 text-sm leading-6 text-text-secondary">{description}</p>
        {error && (
          <p
            role="alert"
            data-testid="archived-delete-operation-error"
            className="mt-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
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
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={`${testId}-cancel-button`}
            onClick={onCancel}
            disabled={submitting}
            className="h-10 min-w-[84px] rounded-xl px-4 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('common.cancel', '取消')}
          </ControlButton>
          <ControlButton
            variant="destructive"
            size="sm"
            type="button"
            data-testid={`${testId}-confirm-button`}
            onClick={onConfirm}
            disabled={submitting}
            className="min-w-[104px]"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </ControlButton>
        </div>
      </DialogSurface>
    </div>,
    document.body
  )
}

export function ArchivedConversationsSettingsPage({
  api: injectedApi,
  ...props
}: ArchivedConversationsSettingsPageProps = {}) {
  const api = useMemo(() => injectedApi ?? createSettingsRuntimeWorkApi(), [injectedApi])
  const [owner, setOwner] = useState({ api, revision: 0 })
  if (owner.api !== api) setOwner({ api, revision: owner.revision + 1 })
  return <ArchivedConversationsSettingsContent key={owner.revision} {...props} api={api} />
}

function ArchivedConversationsSettingsContent({
  api,
  onOpenRuntimeTask,
  onRefreshWorkLists,
  onLeaveSettings,
}: Omit<ArchivedConversationsSettingsPageProps, 'api'> & { api: RuntimeWorkApi }) {
  const { t } = useTranslation('common')
  const [resource] = useState(() => createArchivedConversationsResource(api))
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot)
  const { items, loading } = snapshot
  const [actionError, setError] = useState<string | null>(null)
  const loadMessage = snapshot.failure?.cause instanceof Error ? snapshot.failure.cause.message : ''
  const loadError = snapshot.failure
    ? loadMessage
      ? t(
          'workbench.archived_conversations_load_failed_detail',
          '加载已归档任务失败：{{message}}',
          { message: loadMessage }
        )
      : t('workbench.archived_conversations_load_failed', '加载已归档任务失败')
    : null
  const error = actionError ?? loadError
  const [search, setSearch] = useState('')
  const [source, setSource] = useState<ArchivedSourceFilter>('all')
  const [sort, setSort] = useState<ArchivedSortFilter>('updated')
  const [projectKey, setProjectKey] = useState('all')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)

  const cleanupError = useSyncExternalStore(subscribeArchivedCleanupError, getArchivedCleanupError)
  const bulkDeleteProgress = useSyncExternalStore(
    subscribeArchivedBulkDeleteProgress,
    getArchivedBulkDeleteProgress
  )
  const [lastUnarchived, setLastUnarchived] = useState<ArchivedConversationItem | null>(null)
  const operation = useRef(false)
  const loadArchivedConversations = resource.reload
  useDOMEvent('window', WORKBENCH_CLOUD_ARCHIVES_CHANGED_EVENT, () => void resource.reload())

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
    if (operation.current || !resource.isActive()) return
    operation.current = true
    const key = `unarchive:${item.id}`
    setBusyKey(key)
    setError(null)
    try {
      const harnessSessionId = localHarnessSessionId(item)
      if (harnessSessionId) {
        await unarchiveLocalHarnessSession(harnessSessionId)
        notifyLocalHarnessSessionsChanged()
        if (!resource.isActive()) return
      } else {
        const address = archivedConversationAddress(item)
        const receipt = await api.unarchiveConversation(address)
        if (!receipt.accepted) throw new Error(receipt.error ?? '')
        unmarkRuntimeConversationArchived(address)
        if (!resource.isActive()) return
        await onRefreshWorkLists?.({ unarchivedTasks: [address] })
      }
      if (harnessSessionId) {
        await onRefreshWorkLists?.()
      }
      if (!resource.isActive()) return
      setLastUnarchived(item)
      await loadArchivedConversations()
      track('feature_action_completed', {
        domain: 'archived_conversation',
        action: 'restore',
      })
    } catch (unarchiveError) {
      track('operation_failed', { operation: 'archived_conversation_action' })
      const message = unarchiveError instanceof Error ? unarchiveError.message : ''
      setError(
        message
          ? t('workbench.archived_unarchive_failed_detail', { message })
          : t('workbench.archived_unarchive_failed')
      )
    } finally {
      operation.current = false
      setBusyKey(null)
    }
  }

  const openLastUnarchived = async () => {
    if (!lastUnarchived || operation.current || !resource.isActive()) return
    operation.current = true
    setBusyKey(`open:${lastUnarchived.id}`)
    setError(null)
    try {
      const harnessSessionId = localHarnessSessionId(lastUnarchived)
      if (harnessSessionId) {
        notifyLocalHarnessSessionsChanged(harnessSessionId)
        onLeaveSettings?.()
        return
      }
      if (!onOpenRuntimeTask) return
      await onRefreshWorkLists?.()
      if (!resource.isActive()) return
      await onOpenRuntimeTask(archivedConversationAddress(lastUnarchived))
      if (resource.isActive()) onLeaveSettings?.()
    } catch (openError) {
      const message = openError instanceof Error ? openError.message : ''
      setError(
        message
          ? t('workbench.archived_open_failed_detail', { message })
          : t('workbench.archived_open_failed')
      )
    } finally {
      operation.current = false
      setBusyKey(null)
    }
  }

  const handleDelete = (item: ArchivedConversationItem) => {
    setOperationError(null)
    setPendingDelete({ type: 'single', item })
  }

  const confirmDelete = async () => {
    if (!pendingDelete || operation.current || !resource.isActive()) return
    if (pendingDelete.type !== 'single' && pendingDelete.items.length === 0) return
    if (pendingDelete.type !== 'single' && getArchivedBulkDeleteProgress()?.running) return
    setOperationError(null)
    beginArchivedCleanup(
      (pendingDelete.type === 'single' ? [pendingDelete.item] : pendingDelete.items).map(
        itemAddressKey
      )
    )

    if (pendingDelete.type !== 'single') {
      let deleteItems = pendingDelete.items
      const targetKeys = new Set(deleteItems.map(itemAddressKey))
      setPendingDelete(null)
      setArchivedBulkDeleteProgress({ completed: 0, total: deleteItems.length, running: true })
      try {
        const cleanupErrors: string[] = []
        const harnessItems = deleteItems.filter(item => localHarnessSessionId(item))
        for (const item of harnessItems) {
          await deleteArchivedLocalHarnessSession(localHarnessSessionId(item)!)
          deleteReplyPredictions(archivedConversationAddress(item))
        }
        const deletedHarnessKeys = new Set(harnessItems.map(itemAddressKey))
        notifyArchivedBulkDeleteDeleted(deletedHarnessKeys)
        deleteItems = deleteItems.filter(item => !localHarnessSessionId(item))
        let completed = harnessItems.length
        let total = deleteItems.length
        total += harnessItems.length
        setArchivedBulkDeleteProgress({ completed, total, running: true })
        for (let round = 0; round < ARCHIVED_DELETE_MAX_VERIFY_ROUNDS; round += 1) {
          const deviceItems = new Map<string, ArchivedConversationItem[]>()
          for (const item of deleteItems) {
            const key = JSON.stringify([item.source, item.deviceId])
            const group = deviceItems.get(key) ?? []
            group.push(item)
            deviceItems.set(key, group)
          }
          const batches = [...deviceItems.values()].flatMap(group =>
            chunkItems(group, ARCHIVED_DELETE_BATCH_SIZE)
          )
          for (const batch of batches) {
            const response = await api.deleteArchivedConversationsBulk({
              items: batch.map(archivedConversationAddress),
            })
            // The cloud API wraps each executor's per-task results in a device result.
            const results = response.results.flatMap(result =>
              Array.isArray(result.results)
                ? (result.results as Record<string, unknown>[])
                : [result]
            )
            const cleanupText = cleanupErrorsFromResults(results)
            if (cleanupText) cleanupErrors.push(cleanupText)
            const deletedTaskIds = new Set(
              results
                .filter(result => result.deleted === true)
                .map(result => String(result.taskId || ''))
            )
            const deletedItems = batch.filter(item => deletedTaskIds.has(item.taskId))
            deletedItems.forEach(item => deleteReplyPredictions(archivedConversationAddress(item)))
            const batchDeletedKeys = new Set(deletedItems.map(itemAddressKey))
            notifyArchivedBulkDeleteDeleted(batchDeletedKeys)
            completed += batch.length
            setArchivedBulkDeleteProgress({
              completed,
              total,
              running: true,
            })
          }

          const verified = await resource.fetchAll()
          const refreshedItems = verified.items
          const remainingItems = refreshedItems.filter(
            item => !hasArchivedBulkDeletedKey(itemAddressKey(item))
          )
          resource.applyVerifiedItems(remainingItems, verified)
          const remainingTargetItems = remainingItems.filter(
            item =>
              targetKeys.has(itemAddressKey(item)) &&
              !hasArchivedCleanupFailedKey(itemAddressKey(item))
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
        track('feature_action_completed', {
          domain: 'archived_conversation',
          action: 'delete',
        })
      } catch (deleteError) {
        track('operation_failed', { operation: 'archived_conversation_action' })
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

    operation.current = true
    const { item } = pendingDelete
    const key = `delete:${item.id}`
    setBusyKey(key)
    try {
      const harnessSessionId = localHarnessSessionId(item)
      if (harnessSessionId) {
        await deleteArchivedLocalHarnessSession(harnessSessionId)
        deleteReplyPredictions(archivedConversationAddress(item))
      } else {
        const response = await api.deleteArchivedConversation(archivedConversationAddress(item))
        if (!response.accepted) throw new Error(response.error ?? '')
        deleteReplyPredictions(archivedConversationAddress(item))
        const cleanupText = cleanupErrorsFromResults([
          response as unknown as Record<string, unknown>,
        ])
        if (cleanupText) {
          setOperationError(
            t('workbench.archived_cleanup_partial_failed', '部分文件清理失败: {{message}}', {
              message: cleanupText,
            })
          )
        }
      }
      if (!hasArchivedCleanupFailedKey(itemAddressKey(item))) {
        resource.removeItem(item)
      }
      setPendingDelete(null)
      track('feature_action_completed', {
        domain: 'archived_conversation',
        action: 'delete',
      })
    } catch (deleteError) {
      track('operation_failed', { operation: 'archived_conversation_action' })
      const message = deleteError instanceof Error ? deleteError.message : ''
      setOperationError(
        message
          ? t('workbench.archived_bulk_delete_failed_detail', '删除已归档任务失败：{{message}}', {
              message,
            })
          : t('workbench.archived_bulk_delete_failed', '删除已归档任务失败')
      )
    } finally {
      operation.current = false
      setBusyKey(null)
    }
  }

  const handleBulkDelete = () => {
    const current = resource.getSnapshot()
    if (current.loading || current.failure || current.items.length === 0) return
    setOperationError(null)
    setPendingDelete({ type: 'all', items: current.items })
  }

  const handleProjectDelete = (group: ArchivedProjectGroup) => {
    const current = resource.getSnapshot()
    if (current.loading || current.failure) return
    const projectItems = current.items.filter(item => itemProjectKey(item) === group.key)
    if (projectItems.length === 0) return
    setOperationError(null)
    setPendingDelete({ type: 'project', projectName: group.name, items: projectItems })
  }

  const loadingIndicator = (
    <div
      data-testid="archived-loading"
      className="flex min-h-11 items-center justify-center text-text-secondary"
    >
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {t('workbench.loading', '加载中...')}
    </div>
  )
  const errorIndicator = (
    <div
      data-testid="archived-error"
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive wework:border-red-200 wework:bg-red-50 wework:text-red-600"
    >
      {error}
    </div>
  )

  return (
    <SettingsPage data-testid="archived-conversations-settings-page">
      <SettingsPageHeader
        title={t('workbench.archived_conversations_title', '已归档任务')}
        actions={
          hasArchivedItems ? (
            <ControlButton
              type="button"
              data-testid="archived-bulk-delete-button"
              onClick={handleBulkDelete}
              disabled={bulkDeleteRunning || loading || !!snapshot.failure}
              className="flex h-8 items-center gap-1.5 rounded-md bg-destructive/10 px-2.5 text-sm text-destructive hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-45 max-md:h-11 wework:bg-red-500/10 wework:text-red-500 wework:hover:bg-red-500/15"
            >
              {bulkDeleteRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {t('workbench.archived_bulk_delete', '删除全部')}
            </ControlButton>
          ) : undefined
        }
      />

      {lastUnarchived && (
        <div
          data-testid="archived-unarchive-success"
          className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/10 px-4 py-3 text-sm text-text-primary"
        >
          <span>{t('workbench.archived_unarchive_success', { title: lastUnarchived.title })}</span>
          {(onOpenRuntimeTask || localHarnessSessionId(lastUnarchived)) && (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="archived-view-now-button"
              onClick={() => void openLastUnarchived()}
              disabled={busyKey === `open:${lastUnarchived.id}`}
              className="h-8 shrink-0 rounded-md px-3 text-sm font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {t('workbench.archived_view_now')}
            </ControlButton>
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
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="archived-bulk-delete-progress-dismiss-button"
                onClick={() => setArchivedBulkDeleteProgress(null)}
                className="h-8 rounded-md px-3 text-sm text-text-primary hover:bg-muted"
              >
                {t('workbench.archived_bulk_delete_progress_dismiss', '关闭')}
              </ControlButton>
            )}
          </div>
        </div>
      )}

      {(cleanupError || (operationError && !pendingDelete)) && (
        <div
          data-testid="archived-operation-error"
          role="alert"
          className="mt-4 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive wework:border-red-500/20 wework:bg-red-500/10 wework:text-red-600"
        >
          {cleanupError && <div>{cleanupError}</div>}
          {operationError && !pendingDelete && <div>{operationError}</div>}
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

      {error && (visibleItems.length > 0 || loading) && errorIndicator}
      {loading && visibleItems.length > 0 && loadingIndicator}
      {loadError && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="archived-retry"
          onClick={() => void resource.reload()}
          className="mt-2 min-h-11 rounded-md border border-border px-3 text-sm md:min-h-8"
        >
          {t('common.retry')}
        </ControlButton>
      )}
      <div className="mt-3">
        {loading && visibleItems.length === 0 ? (
          loadingIndicator
        ) : error && visibleItems.length === 0 ? (
          errorIndicator
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
            allowProjectDelete={!loading && !snapshot.failure}
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
          error={operationError}
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
