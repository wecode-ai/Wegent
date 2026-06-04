import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  ProjectTask,
  ProjectWithTasks,
  Subtask,
  Task,
  TaskDetail,
  TaskListResponse,
} from '@/types/api'

interface SearchDialogItem {
  taskId: number
  projectId?: number
  title: string
  projectName?: string
  updatedAt?: string
  createdAt?: string
}

interface DesktopSearchDialogProps {
  open: boolean
  projects: ProjectWithTasks[]
  recentTasks: Task[]
  onOpenChange: (open: boolean) => void
  onOpenTask: (taskId: number, projectId?: number) => void
  onSearchTasks?: (query: string) => Promise<TaskListResponse>
  onSearchTaskDetail?: (taskId: number) => Promise<TaskDetail>
}

function getProjectTaskTitle(task: ProjectTask) {
  return task.task_title || task.title || `Task #${task.task_id}`
}

function sortSearchItems(items: SearchDialogItem[]) {
  return [...items].sort((left, right) => {
    const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime()
    const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime()
    return rightTime - leftTime
  })
}

function buildSearchItems(projects: ProjectWithTasks[], recentTasks: Task[]) {
  const items = new Map<number, SearchDialogItem>()

  projects.forEach(project => {
    project.tasks?.forEach(task => {
      items.set(task.task_id, {
        taskId: task.task_id,
        projectId: project.id,
        title: getProjectTaskTitle(task),
        projectName: project.name,
        updatedAt: task.updated_at,
        createdAt: task.created_at,
      })
    })
  })

  recentTasks.forEach(task => {
    if (items.has(task.id)) return

    const project = task.project_id
      ? projects.find(candidate => candidate.id === task.project_id)
      : undefined

    items.set(task.id, {
      taskId: task.id,
      projectId: task.project_id || undefined,
      title: task.title,
      projectName: project?.name,
      updatedAt: task.updated_at,
      createdAt: task.created_at,
    })
  })

  return sortSearchItems([...items.values()])
}

function buildRemoteSearchItems(projects: ProjectWithTasks[], tasks: Task[]) {
  return sortSearchItems(
    tasks.map(task => {
      const project = task.project_id
        ? projects.find(candidate => candidate.id === task.project_id)
        : undefined

      return {
        taskId: task.id,
        projectId: task.project_id || undefined,
        title: task.title,
        projectName: project?.name,
        updatedAt: task.updated_at,
        createdAt: task.created_at,
      }
    }),
  )
}

function mergeSearchItems(
  localItems: SearchDialogItem[],
  remoteItems: SearchDialogItem[],
) {
  const items = new Map<number, SearchDialogItem>()
  localItems.forEach(item => items.set(item.taskId, item))
  remoteItems.forEach(item => {
    const existing = items.get(item.taskId)
    items.set(item.taskId, {
      ...item,
      ...existing,
      projectId: existing?.projectId ?? item.projectId,
      projectName: existing?.projectName ?? item.projectName,
    })
  })
  return sortSearchItems([...items.values()])
}

function getResultText(result: unknown) {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return ''

  const value = (result as { value?: unknown }).value
  if (typeof value === 'string') return value

  const error = (result as { error?: unknown }).error
  if (typeof error === 'string') return error

  return ''
}

function getSubtaskSearchText(subtask: Subtask) {
  return [subtask.prompt, getResultText(subtask.result)].filter(Boolean).join('\n')
}

function getTaskDetailSearchText(detail: TaskDetail) {
  return detail.subtasks?.map(getSubtaskSearchText).join('\n') ?? ''
}

export function DesktopSearchDialog({
  open,
  projects,
  recentTasks,
  onOpenChange,
  onOpenTask,
  onSearchTasks,
  onSearchTaskDetail,
}: DesktopSearchDialogProps) {
  const { t } = useTranslation('common')
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [detailTextByTaskId, setDetailTextByTaskId] = useState<Record<number, string>>({})
  const [loadingDetailTaskIds, setLoadingDetailTaskIds] = useState<Set<number>>(() => new Set())
  const [remoteSearchState, setRemoteSearchState] = useState<{
    query: string
    items: SearchDialogItem[]
    loading: boolean
  }>({ query: '', items: [], loading: false })
  const searchItems = useMemo(
    () => buildSearchItems(projects, recentTasks),
    [projects, recentTasks],
  )
  const normalizedQuery = query.trim().toLowerCase()
  const activeRemoteItems = useMemo(
    () =>
      remoteSearchState.query === normalizedQuery ? remoteSearchState.items : [],
    [normalizedQuery, remoteSearchState.items, remoteSearchState.query],
  )
  const activeRemoteTaskIds = useMemo(
    () => new Set(activeRemoteItems.map(item => item.taskId)),
    [activeRemoteItems],
  )
  const combinedSearchItems = useMemo(
    () => mergeSearchItems(searchItems, activeRemoteItems),
    [activeRemoteItems, searchItems],
  )
  const filteredItems = useMemo(() => {
    if (!normalizedQuery) return searchItems

    return combinedSearchItems.filter(
      item =>
        activeRemoteTaskIds.has(item.taskId) ||
        [item.title, item.projectName, detailTextByTaskId[item.taskId]]
          .filter(Boolean)
          .some(value => value?.toLowerCase().includes(normalizedQuery)),
    )
  }, [
    activeRemoteTaskIds,
    combinedSearchItems,
    detailTextByTaskId,
    normalizedQuery,
    searchItems,
  ])
  const hasPendingDetailSearch =
    Boolean(normalizedQuery && !onSearchTasks && onSearchTaskDetail) &&
    loadingDetailTaskIds.size > 0
  const hasPendingRemoteSearch =
    Boolean(normalizedQuery && onSearchTasks) &&
    (remoteSearchState.query !== normalizedQuery || remoteSearchState.loading)
  const hasPendingSearch = hasPendingDetailSearch || hasPendingRemoteSearch

  const closeDialog = useCallback(() => {
    setQuery('')
    setRemoteSearchState({ query: '', items: [], loading: false })
    onOpenChange(false)
  }, [onOpenChange])

  useEffect(() => {
    if (!open) return

    const focusTimer = window.setTimeout(() => {
      inputRef.current?.focus()
    }, 0)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDialog()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, closeDialog])

  useEffect(() => {
    if (!open || !normalizedQuery || !onSearchTasks) {
      return
    }

    let cancelled = false
    const queryText = query.trim()

    const searchTimer = window.setTimeout(() => {
      setRemoteSearchState(previous => ({
        query: normalizedQuery,
        items: previous.query === normalizedQuery ? previous.items : [],
        loading: true,
      }))
      void onSearchTasks(queryText)
        .then(result => {
          if (cancelled) return
          setRemoteSearchState({
            query: normalizedQuery,
            items: buildRemoteSearchItems(projects, result.items),
            loading: false,
          })
        })
        .catch(() => {
          if (cancelled) return
          setRemoteSearchState({
            query: normalizedQuery,
            items: [],
            loading: false,
          })
        })
    }, 200)

    return () => {
      cancelled = true
      window.clearTimeout(searchTimer)
    }
  }, [normalizedQuery, onSearchTasks, open, projects, query])

  useEffect(() => {
    if (!open || !normalizedQuery || onSearchTasks || !onSearchTaskDetail) return

    const missingItems = searchItems.filter(
      item =>
        detailTextByTaskId[item.taskId] === undefined &&
        !loadingDetailTaskIds.has(item.taskId),
    )
    if (missingItems.length === 0) return

    let cancelled = false
    const taskIds = missingItems.map(item => item.taskId)
    queueMicrotask(() => {
      if (cancelled) return
      setLoadingDetailTaskIds(previous => new Set([...previous, ...taskIds]))
    })

    void Promise.all(
      missingItems.map(async item => {
        try {
          const detail = await onSearchTaskDetail(item.taskId)
          return [item.taskId, getTaskDetailSearchText(detail)] as const
        } catch {
          return [item.taskId, ''] as const
        }
      }),
    ).then(results => {
      if (cancelled) return

      setDetailTextByTaskId(previous => {
        const next = { ...previous }
        results.forEach(([taskId, text]) => {
          next[taskId] = text
        })
        return next
      })
      setLoadingDetailTaskIds(previous => {
        const next = new Set(previous)
        taskIds.forEach(taskId => next.delete(taskId))
        return next
      })
    })

    return () => {
      cancelled = true
    }
  }, [
    detailTextByTaskId,
    loadingDetailTaskIds,
    normalizedQuery,
    onSearchTasks,
    onSearchTaskDetail,
    open,
    searchItems,
  ])

  if (!open) return null

  const handleOpenItem = (item: SearchDialogItem) => {
    onOpenTask(item.taskId, item.projectId ?? 0)
    closeDialog()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-critical bg-black/10 px-4 pt-[18vh]"
      onMouseDown={event => {
        if (event.target === event.currentTarget) {
          closeDialog()
        }
      }}
    >
      <div
        data-testid="desktop-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('workbench.search_conversations', '搜索对话')}
        className="mx-auto flex max-h-[420px] w-[min(520px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl ring-1 ring-border/70"
      >
        <div className="border-b border-border/70 px-4 py-3">
          <input
            ref={inputRef}
            data-testid="desktop-search-input"
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('workbench.search_conversations', '搜索对话')}
            className="h-8 w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>

        <div className="min-h-0 overflow-y-auto px-2 py-2">
          <div className="px-2 pb-1 text-xs font-medium text-text-muted">
            {t('workbench.recent_conversations', '近期对话')}
          </div>
          {filteredItems.length > 0 ? (
            <div className="space-y-0.5">
              {filteredItems.map(item => (
                <button
                  key={item.taskId}
                  type="button"
                  data-testid={`desktop-search-result-${item.taskId}`}
                  onClick={() => handleOpenItem(item)}
                  className="flex h-8 w-full items-center gap-3 rounded-md px-3 text-left text-[13px] leading-[18px] text-text-primary hover:bg-[rgb(var(--color-sidebar-hover))]"
                >
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  {item.projectName && (
                    <span className="max-w-[140px] shrink-0 truncate text-text-muted">
                      {item.projectName}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ) : hasPendingSearch ? (
            <div className="px-2 py-8 text-center text-sm text-text-muted">
              {t('workbench.searching_conversations', '正在搜索对话...')}
            </div>
          ) : (
            <div className="px-2 py-8 text-center text-sm text-text-muted">
              {t('workbench.search_no_results', '没有匹配的对话')}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
